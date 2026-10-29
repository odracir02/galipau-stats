// Consulta desde otros móviles (src/remote/viewer.ts) contra el Worker real, en
// memoria: el iPhone envía su equipo con el flujo normal y otros dispositivos
// (consulta y entrenador) lo descargan. Nunca toca datos reales ni D1 Preview.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import type { Team } from '../../src/domain/types';
import { loadSeasonItems } from '../../src/services/statsService';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { computeMatchStats, computeSeasonStats } from '../../src/stats/engine';
import { RANKINGS, rankPlayers, seasonCandidates } from '../../src/stats/rankings';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { ClubSync } from '../../src/remote/clubsync';
import { AccountStore } from '../../src/remote/store';
import { stableJson } from '../../src/remote/upload';
import { ClubViewer, seasonItems, ViewerStore } from '../../src/remote/viewer';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
const T0 = Date.UTC(2026, 9, 4, 16, 0, 0);
let n = 0;
let db: SqliteD1;
let env: Env;
let local: IndexedDbRepository;
let localTeam: Team;
let tokens: Record<'coach' | 'otherCoach' | 'viewer' | 'outsider', string>;

const remoteTeam = (role: RemoteTeam['role']): RemoteTeam => ({
  teamId: REMOTE,
  role,
  status: 'active',
  name: 'Senior Masculino A',
  code: 'SMA2627',
  season: '2026/27',
  clubId: 'A',
  clubName: 'Club A',
});

const api: Api = createApi({ baseUrl: 'https://api.example', fetch: async (input, init) => worker.fetch(new Request(input as string, init), env) });

async function device(token: string, id: string) {
  const store = new AccountStore(`cuenta-${n}-${id}`);
  await store.saveDevice({ deviceId: id, token, joinedAt: new Date(T0).toISOString() });
  return store;
}

/** Instantánea de toda la base del servidor (para comprobar que la consulta no escribe nada). */
function serverDump(): string {
  const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return JSON.stringify(Object.fromEntries(tables.map((t) => [t, db.sqlite.prepare(`SELECT * FROM ${t}`).all()])));
}

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addClub(db, 'B');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  addTeam(db, 'b1', 'B', 'SMA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  tokens = {
    coach: (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    otherCoach: (await addDevice(db, 'otro-entrenador', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    viewer: (await addDevice(db, 'familia', [{ clubId: 'A', teamId: REMOTE, role: 'viewer' }])).token,
    outsider: (await addDevice(db, 'otro-club', [{ clubId: 'B', teamId: 'b1', role: 'viewer' }])).token,
  };

  // El iPhone: equipo local con datos variados, enviado con el flujo normal.
  local = new IndexedDbRepository(`local-${n}`);
  localTeam = await createTeam(local, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
  const ids: string[] = [];
  for (const [num, pos] of [[7, 'field'], [9, 'field'], [14, 'field'], [22, 'field'], [1, 'goalkeeper']] as const) {
    ids.push((await savePlayer(local, localTeam.id, { name: `Jugador ${num}`, number: num, position: pos, active: true })).id);
  }
  const [p7, p9, p14, p22, g1] = ids as [string, string, string, string, string];
  const t0 = { period: 1 as const, matchTimeMs: 0 };
  const goal = { kind: 'shot', shotType: 'nine_m', result: 'goal' } as const;
  for (const [opponent, date, scorers, adj] of [
    ['CH Xàtiva', '2026-10-04', [p7, p7, p9, p22], { own: 20, opponent: 22 }],
    ['C. BM Quart', '2026-10-11', [p9, p14], { own: 20, opponent: 0 }],
    ['BM Marni', '2026-10-18', [p7, p14, p14, p22, p22, p22], { own: 27, opponent: 0 }],
  ] as const) {
    let m = await svc.createMatch(local, { teamId: localTeam.id, opponent, date, venue: 'away', season: '2026/27', playerIds: ids });
    for (const s of scorers) await svc.recordEvent(local, m, goal, s, t0);
    for (let i = 0; i < 12; i++) await svc.recordEvent(local, m, { kind: 'gk_shot', shotType: 'nine_m', result: i % 3 ? 'goal' : 'save' }, g1, t0);
    await svc.recordEvent(local, m, { kind: 'free_throw' }, null, t0);
    await svc.recordEvent(local, m, { kind: 'turnover', turnoverType: 'steps' }, null, t0);
    const ex = await svc.recordEvent(local, m, { kind: 'exclusion' }, p14, t0);
    const red = await svc.recordEvent(local, m, { kind: 'red' }, p14, t0);
    await svc.setAddsToPrevious(local, red, true);
    void ex;
    await svc.deleteEvent(local, await svc.recordEvent(local, m, goal, p9, t0));
    m = await svc.setScoreAdjustment(local, m, adj);
    await svc.finishMatch(local, m, T0);
  }
  const iphone = new ClubSync(local, await device(tokens.coach, 'iphone'), api, () => [remoteTeam('coach')], () => new Date(T0));
  await iphone.link(localTeam.id, REMOTE);
  expect((await iphone.upload(localTeam.id)).status).toBe('verified');
});

describe('consulta desde otros móviles', () => {
  for (const [who, role] of [
    ['viewer', 'viewer'],
    ['otherCoach', 'coach'],
  ] as const) {
    it(`${who === 'viewer' ? 'código de jugador/familia' : 'entrenador desde otro móvil'}: mismas estadísticas, resultados y rankings que el iPhone`, async () => {
      const viewer = new ClubViewer(api, await device(tokens[who], who), new ViewerStore(`consulta-${n}-${who}`));
      await viewer.refresh(remoteTeam(role));
      const view = viewer.view(REMOTE);
      expect(view.problem).toBeNull();
      const snap = view.cached!.snapshot;
      expect(snap.players).toHaveLength(5);
      expect(snap.matches).toHaveLength(3);

      const localItems = await loadSeasonItems(local, localTeam.id);
      const remoteItems = seasonItems(snap);
      const json = (s: ReturnType<typeof computeSeasonStats>) => stableJson({ ...s, players: [...s.players.entries()].sort() });
      expect(json(computeSeasonStats(remoteItems))).toBe(json(computeSeasonStats(localItems)));
      // Resultados oficiales (con correcciones) partido a partido.
      const score = (items: typeof localItems) =>
        items.map(({ match, events }) => [match.opponent, computeMatchStats(match, events).score.own, computeMatchStats(match, events).score.opponent]).sort();
      expect(score(remoteItems)).toEqual(score(localItems));
      expect(score(remoteItems)).toEqual([
        ['BM Marni', 33, 8],
        ['C. BM Quart', 22, 8],
        ['CH Xàtiva', 24, 30],
      ]);
      // Los siete rankings.
      expect(RANKINGS).toHaveLength(7);
      for (const def of RANKINGS) {
        const r = (items: typeof localItems) => rankPlayers(def, seasonCandidates(computeSeasonStats(items))).map((e) => [e.position, e.player.playerId, e.value]);
        expect(r(remoteItems), def.id).toEqual(r(localItems));
      }
      // Datos especiales tal cual.
      expect(snap.events.filter((e) => e.event.addsToPrevious === true)).toHaveLength(3);
      expect(snap.events.filter((e) => e.event.deletedAt !== null)).toHaveLength(3);
      expect(snap.events.filter((e) => e.event.kind === 'free_throw' && e.event.playerId === null)).toHaveLength(3);
    });
  }

  it('la consulta no escribe nada en el servidor', async () => {
    const before = serverDump();
    const viewer = new ClubViewer(api, await device(tokens.viewer, 'familia'), new ViewerStore(`consulta-${n}-ro`));
    for (let i = 0; i < 3; i++) await viewer.refresh(remoteTeam('viewer'));
    expect(serverDump()).toBe(before);
  });

  it('no se descargan equipos sin permiso (otro club): nada guardado', async () => {
    const store = new ViewerStore(`consulta-${n}-fuera`);
    const viewer = new ClubViewer(api, await device(tokens.outsider, 'otro-club'), store);
    await viewer.refresh(remoteTeam('viewer'));
    expect(viewer.view(REMOTE)).toMatchObject({ cached: null, problem: 'no_access' });
    expect(await store.keys()).toEqual([]);
  });

  it('acceso retirado en el servidor: al actualizar desaparecen los datos descargados', async () => {
    const store = new ViewerStore(`consulta-${n}-revocado`);
    const viewer = new ClubViewer(api, await device(tokens.viewer, 'familia'), store);
    await viewer.refresh(remoteTeam('viewer'));
    expect(await store.keys()).toEqual([REMOTE]);
    db.run("UPDATE grants SET revoked_at = '2026-10-30T00:00:00.000Z' WHERE device_id = 'familia'");
    await viewer.refresh(remoteTeam('viewer'));
    expect(viewer.view(REMOTE)).toMatchObject({ cached: null, problem: 'no_access' });
    expect(await store.keys()).toEqual([]);
  });

  it('descargar no cambia la base local del iPhone', async () => {
    const before = await local.readAll();
    const viewer = new ClubViewer(api, await device(tokens.coach, 'iphone'), new ViewerStore(`consulta-${n}-iphone`));
    await viewer.refresh(remoteTeam('coach'));
    expect(await local.readAll()).toEqual(before);
  });
});
