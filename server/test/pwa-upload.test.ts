// Vinculación y envío de la PWA (src/remote/*) contra el Worker real, en memoria,
// con una base local (IndexedDB simulada) que contiene datos especiales. Nunca
// toca los datos reales ni la base de datos de Preview.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import type { Match, Team } from '../../src/domain/types';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { ClubSync } from '../../src/remote/clubsync';
import { AccountStore, LinkTakenError } from '../../src/remote/store';
import { UploadBusyError } from '../../src/remote/upload';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
const T0 = Date.UTC(2026, 9, 4, 16, 0, 0);
const MIN = 60_000;
let n = 0;
let db: SqliteD1;
let env: Env;
let local: IndexedDbRepository;
let localTeam: Team;
let tokens: { coach: string; other: string; viewer: string };

const remoteTeam = (role: RemoteTeam['role'] = 'coach'): RemoteTeam => ({
  teamId: REMOTE,
  role,
  status: 'active',
  name: 'Senior Masculino A',
  code: 'SMA2627',
  season: '2026/27',
  clubId: 'A',
  clubName: 'Club A',
});

/** fetch de la PWA hacia el Worker en memoria; `cut` simula cortes de red. */
function apiFor(cut: { after?: number; afterApplied?: boolean } = {}): Api & { calls: () => number } {
  let calls = 0;
  const api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      calls++;
      const req = new Request(input as string, init);
      if (cut.after !== undefined && calls > cut.after) {
        if (cut.afterApplied) await worker.fetch(req, env); // el servidor lo aplica, pero la respuesta se pierde
        throw new TypeError('Failed to fetch');
      }
      return worker.fetch(req, env);
    },
  });
  return Object.assign(api, { calls: () => calls });
}

async function syncFor(token: string, deviceId: string, role: RemoteTeam['role'] = 'coach', api: Api = apiFor(), storeName = `cuenta-${n}-${deviceId}`) {
  const store = new AccountStore(storeName);
  await store.saveDevice({ deviceId, token, joinedAt: new Date(T0).toISOString() });
  const sync = new ClubSync(local, store, api, () => [remoteTeam(role)], () => new Date(T0), { retryDelays: [1, 1], sleep: async () => undefined });
  return { sync, store };
}

const count = (table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const counts = () => ['players', 'matches', 'match_squad', 'events', 'change_log'].map(count);

/** Equipo local con datos de todo tipo, como los del iPhone. */
async function seedLocal(): Promise<void> {
  localTeam = await createTeam(local, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16, publicName: 'BM Burjassot' });
  const ps = [];
  for (const [num, pos] of [[7, 'field'], [9, 'field'], [14, 'field'], [1, 'goalkeeper']] as const) {
    ps.push(await savePlayer(local, localTeam.id, { name: `Jugador ${num}`, number: num, position: pos, active: true }));
  }
  const inactive = await savePlayer(local, localTeam.id, { name: 'Antiguo', number: 30, position: 'field', active: true });
  await savePlayer(local, localTeam.id, { ...inactive, active: false }, inactive);
  const ids = ps.map((p) => p.id);
  const [p7, p9, p14, g1] = ids as [string, string, string, string];
  const match = (opponent: string, date: string) =>
    svc.createMatch(local, { teamId: localTeam.id, opponent, date, venue: 'away', season: '2026/27', playerIds: ids });

  // 1. Histórico sin reloj: acciones a 00:00, golpe franco, corrección de marcador, acción borrada.
  let m1: Match = await match('CH Xàtiva', '2026-10-04');
  const t0 = { period: 1 as const, matchTimeMs: 0 };
  await svc.recordEvent(local, m1, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, p7, t0);
  await svc.recordEvent(local, m1, { kind: 'gk_shot', shotType: 'six_m', result: 'save' }, g1, t0);
  await svc.recordEvent(local, m1, { kind: 'free_throw' }, null, t0);
  await svc.recordEvent(local, m1, { kind: 'recovery' }, null, t0); // pendiente de atribuir
  const wrong = await svc.recordEvent(local, m1, { kind: 'shot', shotType: 'six_m', result: 'goal' }, p9, t0);
  await svc.deleteEvent(local, wrong);
  m1 = await svc.setScoreAdjustment(local, m1, { own: 23, opponent: 22 });
  await svc.finishMatch(local, m1, T0);

  // 2. Con reloj: sanción adicional (4 min) y fin real de la 1.ª parte.
  let m2 = await svc.toggleClock(local, await match('C. BM Quart', '2026-10-11'), T0);
  const ex = await svc.recordEvent(local, m2, { kind: 'exclusion' }, p14, svc.currentTiming(m2, T0 + 29 * MIN));
  const red = await svc.recordEvent(local, m2, { kind: 'red' }, p14, svc.currentTiming(m2, T0 + 29 * MIN));
  await svc.setAddsToPrevious(local, red, true);
  void ex;
  m2 = await svc.startHalftime(local, m2, T0 + 30 * MIN + 20_000);
  m2 = await svc.toggleClock(local, m2, T0 + 45 * MIN);
  await svc.recordEvent(local, m2, { kind: 'gk_shot', shotType: 'nine_m', result: 'goal' }, g1, svc.currentTiming(m2, T0 + 46 * MIN));
  await svc.finishMatch(local, m2, T0 + 80 * MIN);

  // 3. Partido eliminado en el dispositivo: no se envía.
  const gone = await match('Prueba', '2026-10-01');
  await svc.recordEvent(local, gone, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, p7, t0);
  await svc.deleteMatch(local, gone);
}

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  addTeam(db, 'otro', 'A', 'JMA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  tokens = {
    coach: (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    other: (await addDevice(db, 'otro-movil', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    viewer: (await addDevice(db, 'familia', [{ clubId: 'A', teamId: REMOTE, role: 'viewer' }])).token,
  };
  local = new IndexedDbRepository(`local-${n}`);
  await seedLocal();
});

describe('vinculación', () => {
  it('nunca automática: aunque los códigos coincidan, sin vincular no hay nada que enviar', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    expect(await sync.getLink(localTeam.id)).toBeNull();
    await expect(sync.preview(localTeam.id)).rejects.toMatchObject({ kind: 'not_found' });
    expect(count('players')).toBe(0);
  });

  it('vincular guarda la correspondencia aparte y no cambia nada local', async () => {
    const before = await local.readAll();
    const { sync } = await syncFor(tokens.coach, 'iphone');
    expect((await sync.linkCandidates()).map((t) => t.teamId)).toEqual([REMOTE]);
    const link = await sync.link(localTeam.id, REMOTE);
    expect(link).toMatchObject({ localTeamId: localTeam.id, remoteTeamId: REMOTE, remoteTeamCode: 'SMA2627' });
    expect(await local.readAll()).toEqual(before);
    expect(await sync.linkCandidates()).toEqual([]);
  });

  it('un equipo local no se vincula dos veces, ni dos equipos locales al mismo del club', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    await expect(sync.link(localTeam.id, REMOTE)).rejects.toBeInstanceOf(LinkTakenError);
    const second = await createTeam(local, { name: 'Copia', code: 'COPIA1', season: '2026/27', maxSquad: 16 });
    await expect(sync.link(second.id, REMOTE)).rejects.toBeInstanceOf(LinkTakenError);
  });

  it('con acceso de consulta no se puede vincular para escribir', async () => {
    const { sync } = await syncFor(tokens.viewer, 'familia', 'viewer');
    expect(await sync.linkCandidates()).toEqual([]);
    await expect(sync.link(localTeam.id, REMOTE)).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('deshacer un vínculo solo antes de enviar nada', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    await sync.unlink(localTeam.id);
    expect(await sync.getLink(localTeam.id)).toBeNull();
    await sync.link(localTeam.id, REMOTE);
    await sync.upload(localTeam.id);
    await expect(sync.unlink(localTeam.id)).rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('previsualización', () => {
  it('cuenta lo que se enviará y lo que no, y no encuentra problemas', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    const plan = await sync.preview(localTeam.id);
    expect(plan.problems).toEqual([]);
    expect(plan.summary).toEqual({
      players: 5,
      inactivePlayers: 1,
      matches: 2,
      squadEntries: 8,
      events: 8,
      deletedEvents: 1,
      pendingEvents: 1,
      freeThrows: 1,
      additionalSanctions: 1,
      scoreCorrections: 1,
      matchDeletions: 0,
      skippedMatches: 1,
      skippedEvents: 1,
    });
  });

  it('detecta lo que el servidor no aceptaría, sin transformarlo', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    const [m] = await local.listMatches(localTeam.id);
    // Acción de un jugador que no está en la convocatoria (dato antiguo o importado).
    await local.saveEvent({ id: 'raro', matchId: m!.id, playerId: 'no-convocado', period: 1, matchTimeMs: 0, createdAt: m!.createdAt, updatedAt: m!.createdAt, deletedAt: null, kind: 'recovery' });
    const plan = await sync.preview(localTeam.id);
    expect(plan.problems.some((p) => /no está convocado/.test(p))).toBe(true);
    await expect(sync.upload(localTeam.id)).rejects.toMatchObject({ kind: 'invalid' });
    expect(count('players')).toBe(0);
  });
});

describe('envío', () => {
  it('subida completa en orden, verificada con el servidor, sin tocar los datos locales', async () => {
    const before = await local.readAll();
    const { sync, store } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    const phases: string[] = [];
    const out = await sync.upload(localTeam.id, (p) => phases.at(-1) !== p.phase && phases.push(p.phase));
    expect(out).toMatchObject({ status: 'verified', sent: { players: 5, matches: 2, events: 8 }, differences: [] });
    expect(phases).toEqual(['players', 'matches', 'events', 'verify']);
    expect(counts()).toEqual([5, 2, 8, 8, 15]);
    expect(await local.readAll()).toEqual(before);
    expect((await local.getTeam(localTeam.id))?.publicName).toBe('BM Burjassot');
    expect(await store.lastUpload(localTeam.id)).toMatchObject({ status: 'verified', sent: { players: 5, matches: 2, events: 8 } });
    expect(JSON.stringify(await store.lastUpload(localTeam.id))).not.toContain(tokens.coach);
  });

  it('los datos especiales llegan con su significado', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    await sync.upload(localTeam.id);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'free_throw' AND player_id IS NULL").get()).toEqual({ n: 1 });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE adds_to_previous = 1').get()).toEqual({ n: 1 });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE deleted_at IS NOT NULL').get()).toEqual({ n: 1 });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE match_time_ms = 0').get()).toEqual({ n: 5 });
    const clocks = db.sqlite.prepare("SELECT clock_json FROM matches WHERE opponent = 'C. BM Quart'").get() as { clock_json: string };
    expect(JSON.parse(clocks.clock_json).firstHalfEndMs).toBe(30 * MIN + 20_000);
    expect(db.sqlite.prepare("SELECT score_adj_own, score_adj_opponent FROM matches WHERE opponent = 'CH Xàtiva'").get()).toEqual({ score_adj_own: 23, score_adj_opponent: 22 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM matches WHERE opponent = 'Prueba'").get()).toEqual({ n: 0 });
  });

  it('repetir el envío no duplica ni cambia nada', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    await sync.upload(localTeam.id);
    const before = counts();
    const again = await sync.upload(localTeam.id);
    expect(again).toMatchObject({ status: 'verified', sent: { players: 0, matches: 0, events: 0 }, unchanged: 15 });
    expect(counts()).toEqual(before);
  });

  it('corte de red a mitad: se detiene sin duplicar y el siguiente envío completa', async () => {
    const cutApi = apiFor({ after: 8 });
    const { sync, store } = await syncFor(tokens.coach, 'iphone', 'coach', cutApi);
    await sync.link(localTeam.id, REMOTE);
    const out = await sync.upload(localTeam.id);
    expect(out).toMatchObject({ status: 'stopped', stop: { reason: 'offline' } });
    expect(await store.lastUpload(localTeam.id)).toMatchObject({ status: 'interrupted' });
    const partial = counts();
    expect(partial[0]).toBe(5);
    // Vuelve la red: mismo almacén (mismo dispositivo), continúa donde se quedó.
    const resumed = new ClubSync(local, store, apiFor(), () => [remoteTeam()], () => new Date(T0), { retryDelays: [1], sleep: async () => undefined });
    const done = await resumed.upload(localTeam.id);
    expect(done.status).toBe('verified');
    expect(counts()).toEqual([5, 2, 8, 8, 15]);
  });

  it('respuesta perdida tras aplicarse en el servidor: el reintento no duplica', async () => {
    const lossy = apiFor({ after: 3, afterApplied: true });
    const { sync, store } = await syncFor(tokens.coach, 'iphone', 'coach', lossy);
    await sync.link(localTeam.id, REMOTE);
    expect((await sync.upload(localTeam.id)).status).toBe('stopped');
    const resumed = new ClubSync(local, store, apiFor(), () => [remoteTeam()], () => new Date(T0), { retryDelays: [1], sleep: async () => undefined });
    expect((await resumed.upload(localTeam.id)).status).toBe('verified');
    expect(counts()).toEqual([5, 2, 8, 8, 15]);
  });

  it('conflicto de versiones: se detiene sin sobrescribir el servidor ni tocar lo local', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    await sync.upload(localTeam.id);
    // Alguien cambió la acción en el servidor (versión 2); aquí se corrige la misma acción.
    const ev = (await local.readAll()).events.find((e) => e.kind === 'free_throw')!;
    db.run("UPDATE events SET match_time_ms = 999, version = 2 WHERE id = ?", ev.id);
    const [m] = await local.listMatches(localTeam.id);
    await svc.updateEvent(local, m!, ev, { matchTimeMs: 5 * MIN });
    const before = await local.readAll();
    const out = await sync.upload(localTeam.id);
    expect(out).toMatchObject({ status: 'stopped', stop: { reason: 'conflict' } });
    expect(db.sqlite.prepare('SELECT match_time_ms, version FROM events WHERE id = ?').get(ev.id)).toEqual({ match_time_ms: 999, version: 2 });
    expect(await local.readAll()).toEqual(before);
  });

  it('otro dispositivo no puede escribir los partidos ya registrados', async () => {
    const first = await syncFor(tokens.coach, 'iphone');
    await first.sync.link(localTeam.id, REMOTE);
    await first.sync.upload(localTeam.id);
    const other = await syncFor(tokens.other, 'otro-movil');
    await other.sync.link(localTeam.id, REMOTE);
    const out = await other.sync.upload(localTeam.id);
    expect(out).toMatchObject({ status: 'stopped', stop: { reason: 'recorded_elsewhere' } });
    expect(counts()).toEqual([5, 2, 8, 8, 15]);
  });

  it('con acceso de consulta el servidor rechaza el envío (403) aunque se intente', async () => {
    // El dispositivo cree tener permiso (datos guardados antiguos), pero su token es de consulta.
    const { sync } = await syncFor(tokens.viewer, 'familia', 'coach');
    await sync.link(localTeam.id, REMOTE);
    const out = await sync.upload(localTeam.id);
    expect(out).toMatchObject({ status: 'stopped', stop: { reason: 'forbidden' } });
    expect(count('players')).toBe(0);
  });

  it('si el servidor no coincide tras el envío, no se da por completado', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    await sync.upload(localTeam.id);
    db.run("UPDATE matches SET score_adj_own = 0 WHERE opponent = 'CH Xàtiva'");
    const out = await sync.upload(localTeam.id);
    expect(out.status).toBe('differences');
    expect(out.differences.some((d) => /CH Xàtiva.*datos del partido/.test(d))).toBe(true);
    expect(out.differences.some((d) => /resultado distinto/.test(d))).toBe(true);
  });

  it('no permite dos envíos a la vez del mismo equipo', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    const results = await Promise.allSettled([sync.upload(localTeam.id), sync.upload(localTeam.id)]);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof UploadBusyError)).toHaveLength(1);
    expect(counts()).toEqual([5, 2, 8, 8, 15]);
  });

  it('una sesión revocada detiene el envío sin tocar nada', async () => {
    const { sync } = await syncFor(tokens.coach, 'iphone');
    await sync.link(localTeam.id, REMOTE);
    db.run("UPDATE device_tokens SET revoked_at = '2026-10-01T00:00:00.000Z'");
    expect(await sync.upload(localTeam.id)).toMatchObject({ status: 'stopped', stop: { reason: 'unauthorized' } });
    expect(count('players')).toBe(0);
  });
});
