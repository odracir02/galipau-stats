// Envío automático (src/remote/autosync.ts) contra el Worker real, en memoria,
// con el repositorio observable y los servicios de partido de la app. Esperas
// cortas para la prueba. Nunca toca datos reales ni D1 Preview.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObservableRepository } from '../../src/app/observableRepository';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import type { Match, Team } from '../../src/domain/types';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { AutoSync } from '../../src/remote/autosync';
import { ClubSync } from '../../src/remote/clubsync';
import { AccountStore } from '../../src/remote/store';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
const MIN = 60_000;
let n = 0;
let db: SqliteD1;
let env: Env;
let local: ObservableRepository;
let team: Team;
let ids: string[];
let match: Match;
let coachToken: string;
let net: { down: boolean; writes: number; reads: number };

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

/** fetch hacia el Worker en memoria, con corte de red simulado y recuento de peticiones. */
const api: Api = createApi({
  baseUrl: 'https://api.example',
  fetch: async (input, init) => {
    if (net.down) throw new TypeError('Failed to fetch');
    if ((init?.method ?? 'GET') === 'POST') net.writes++;
    else net.reads++;
    return worker.fetch(new Request(input as string, init), env);
  },
});

const count = (sql: string) => (db.sqlite.prepare(sql).get() as { n: number }).n;

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('No se cumplió la condición a tiempo');
}

/** Deja llegar los avisos de cambio y espera a que el envío automático quede en reposo con ese estado. */
async function settle(auto: AutoSync, status: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
  await waitFor(() => auto.idle(team.id) && auto.state(team.id).status === status);
}

/** Dispositivo completo: almacén, envío manual y automático, conectado al repositorio. */
async function deviceSetup(token: string, deviceId: string, role: RemoteTeam['role'] = 'coach', storeName = `cuenta-${n}-${deviceId}`) {
  const store = new AccountStore(storeName);
  await store.saveDevice({ deviceId, token, joinedAt: '2026-10-30T10:00:00.000Z' });
  const teams = () => [remoteTeam(role)];
  const sync = new ClubSync(local, store, api, teams);
  const previews = { n: 0 };
  const counted = new Proxy(sync, {
    get(target, prop, receiver) {
      if (prop === 'preview') return (id: string) => (previews.n++, target.preview(id));
      return Reflect.get(target, prop, receiver);
    },
  });
  const auto = new AutoSync(counted, store, api, teams, { quietMs: 120, maxWaitMs: 1000, retryMs: [80] });
  const off = local.onChange((c) => c.entity !== 'team' && auto.changed(c.teamId));
  alive.push({ auto, off });
  return { store, sync, auto, previews, off };
}

/** Servicios de cada prueba: se detienen al terminar para que no envíen a la base de la siguiente. */
let alive: { auto: AutoSync; off: () => void }[] = [];
afterEach(async () => {
  for (const a of alive) {
    a.off();
    await a.auto.dispose();
  }
  alive = [];
});

beforeEach(async () => {
  n++;
  net = { down: false, writes: 0, reads: 0 };
  db = migratedDb();
  addClub(db, 'A');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  coachToken = (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token;
  local = new ObservableRepository(new IndexedDbRepository(`local-${n}`));
  team = await createTeam(local, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
  ids = [];
  for (const [num, pos] of [[7, 'field'], [9, 'field'], [1, 'goalkeeper']] as const) {
    ids.push((await savePlayer(local, team.id, { name: `Jugador ${num}`, number: num, position: pos, active: true })).id);
  }
  match = await svc.createMatch(local, { teamId: team.id, opponent: 'BM Rival', date: '2026-10-31', venue: 'home', season: '2026/27', playerIds: ids });
  for (let i = 0; i < 20; i++) {
    await svc.recordEvent(local, match, { kind: 'shot', shotType: 'nine_m', result: i % 2 ? 'goal' : 'out' }, ids[i % 2]!, { period: 1, matchTimeMs: 0 });
  }
});

/** Primer envío manual completo (como el de los 273 eventos reales) y activación expresa del automático. */
async function firstManualUpload(d: Awaited<ReturnType<typeof deviceSetup>>, { enable = true } = {}) {
  await d.sync.link(team.id, REMOTE);
  expect((await d.sync.upload(team.id)).status).toBe('verified');
  if (enable) {
    await d.auto.setEnabled(team.id, true);
    await settle(d.auto, 'synced');
  }
  net.writes = 0;
  net.reads = 0;
  d.previews.n = 0;
}

describe('envío automático', () => {
  it('lo ya enviado no se vuelve a subir: comprobar pendientes no hace ninguna petición', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    await d.auto.checkAll();
    await settle(d.auto, 'synced');
    expect(net).toMatchObject({ writes: 0, reads: 0 });
  });

  it('agrupa una ráfaga de acciones en un solo envío, en orden y sin bloquear el registro', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    const t0 = performance.now();
    for (let i = 0; i < 6; i++) await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: (i + 1) * 1000 });
    const recording = performance.now() - t0;
    expect(d.auto.state(team.id).status).toBe('pending');
    await settle(d.auto, 'synced');
    expect(d.previews.n).toBe(1); // una sola tanda
    expect(net.writes).toBe(6);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'recovery'")).toBe(6);
    // El registro no esperó por el envío (las 6 acciones se guardaron antes de la primera petición).
    expect(recording).toBeLessThan(120);
  });

  it('modificar, deshacer y borrar acciones también se envía, sin duplicar', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    const e = await svc.recordEvent(local, match, { kind: 'yellow' }, ids[1]!, { period: 1, matchTimeMs: 5 * MIN });
    const moved = await svc.updateEvent(local, match, e, { matchTimeMs: 6 * MIN });
    await svc.undoLast(local, await local.listEvents(match.id));
    void moved;
    await settle(d.auto, 'synced');
    expect(db.sqlite.prepare("SELECT match_time_ms, deleted_at IS NOT NULL AS borrada, version FROM events WHERE kind = 'yellow'").get()).toEqual({
      match_time_ms: 6 * MIN,
      borrada: 1,
      version: 1,
    });
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(21);
  });

  it('el cronómetro solo se envía al cambiar su estado, nunca por el paso del tiempo', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    match = await svc.toggleClock(local, match, Date.now());
    await settle(d.auto, 'synced');
    expect(net.writes).toBe(1);
    // Pasa el tiempo con el reloj en marcha: no hay cambios guardados ni envíos.
    await new Promise((r) => setTimeout(r, 400));
    await d.auto.checkAll();
    await settle(d.auto, 'synced');
    expect(net.writes).toBe(1);
    // Descanso y segunda parte: el fin real de la 1.ª parte llega al servidor.
    match = await svc.startHalftime(local, match, Date.now());
    match = await svc.toggleClock(local, match, Date.now());
    await waitFor(async () => d.auto.state(team.id).status === 'synced' && JSON.parse((db.sqlite.prepare('SELECT clock_json FROM matches').get() as { clock_json: string }).clock_json).period === 2);
    expect(JSON.parse((db.sqlite.prepare('SELECT clock_json FROM matches').get() as { clock_json: string }).clock_json).firstHalfEndMs).toBeTypeOf('number');
  });

  it('sanción adicional (4 min) y corrección de marcador llegan tal cual', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    await svc.recordEvent(local, match, { kind: 'exclusion' }, ids[0]!, { period: 1, matchTimeMs: 10 * MIN });
    const red = await svc.recordEvent(local, match, { kind: 'red' }, ids[0]!, { period: 1, matchTimeMs: 10 * MIN });
    await svc.setAddsToPrevious(local, red, true);
    match = await svc.setScoreAdjustment(local, match, { own: 2, opponent: 1 });
    await settle(d.auto, 'synced');
    expect(db.sqlite.prepare("SELECT adds_to_previous FROM events WHERE kind = 'red'").get()).toEqual({ adds_to_previous: 1 });
    expect(db.sqlite.prepare('SELECT score_adj_own, score_adj_opponent FROM matches').get()).toEqual({ score_adj_own: 2, score_adj_opponent: 1 });
  });

  it('sin conexión conserva los cambios y los envía al volver, sin duplicados', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    net.down = true;
    for (let i = 0; i < 3; i++) await svc.recordEvent(local, match, { kind: 'recovery' }, ids[1]!, { period: 1, matchTimeMs: i * 1000 });
    await waitFor(() => d.auto.state(team.id).status === 'offline');
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'recovery'")).toBe(0);
    expect((await local.listEvents(match.id)).filter((e) => e.kind === 'recovery')).toHaveLength(3);
    net.down = false;
    await d.auto.checkAll(); // como el evento «online»
    await settle(d.auto, 'synced');
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'recovery'")).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(23);
  });

  it('cambios hechos con la app «cerrada» se envían al volver a abrirla', async () => {
    const first = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(first);
    first.off(); // la app se cierra: ya nadie escucha los cambios
    await svc.recordEvent(local, match, { kind: 'turnover', turnoverType: 'steps' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    await new Promise((r) => setTimeout(r, 250));
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'turnover'")).toBe(0);
    // Se vuelve a abrir: mismo almacén (mismo dispositivo); al arrancar se miran los pendientes.
    const reopened = await deviceSetup(coachToken, 'iphone', 'coach', `cuenta-${n}-iphone`);
    await reopened.auto.checkAll();
    await settle(reopened.auto, 'synced');
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'turnover'")).toBe(1);
  });

  it('conflicto de versiones: se detiene, avisa, no sobrescribe y no se reanuda solo', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    const [ev] = await local.listEvents(match.id);
    db.run('UPDATE events SET match_time_ms = 999, version = 2 WHERE id = ?', ev!.id);
    await svc.updateEvent(local, match, ev!, { matchTimeMs: 7 * MIN });
    await waitFor(() => d.auto.state(team.id).status === 'attention');
    expect(d.auto.state(team.id).message).toMatch(/cambiado en el servidor/);
    expect(db.sqlite.prepare('SELECT match_time_ms FROM events WHERE id = ?').get(ev!.id)).toEqual({ match_time_ms: 999 });
    expect((await d.store.getLink(team.id))?.autoBlocked).toBeTruthy();
    // Nuevos cambios: no se envían mientras requiera atención (tampoco tras reabrir).
    const writes = net.writes;
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(net.writes).toBe(writes);
    const reopened = await deviceSetup(coachToken, 'iphone', 'coach', `cuenta-${n}-iphone`);
    await reopened.auto.checkAll();
    expect(reopened.auto.state(team.id).status).toBe('attention');
  });

  it('sesión revocada: se detiene sin enviar nada', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    db.run("UPDATE device_tokens SET revoked_at = '2026-10-30T00:00:00.000Z'");
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    await waitFor(() => d.auto.state(team.id).status === 'attention');
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'recovery'")).toBe(0);
  });

  it('con permiso de consulta no envía nada', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    d.off();
    const viewer = await deviceSetup(coachToken, 'iphone', 'viewer', `cuenta-${n}-iphone`);
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    await waitFor(() => viewer.auto.state(team.id).status === 'attention');
    expect(net.writes).toBe(0);
  });

  it('envío manual y automático a la vez: nunca simultáneos y sin duplicados', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    const link = await d.sync.link(team.id, REMOTE);
    await d.store.updateLink({ ...link, auto: true });
    // Primer envío manual en curso mientras el automático intenta enviar el mismo equipo.
    const manual = d.sync.upload(team.id);
    await d.auto.checkAll();
    expect((await manual).status).toBe('verified');
    await settle(d.auto, 'synced');
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(20);
    expect(count('SELECT COUNT(*) AS n FROM players')).toBe(3);
  });

  it('un partido ya enviado que se elimina en el dispositivo se elimina también en el club', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    await svc.deleteMatch(local, match);
    await settle(d.auto, 'synced');
    expect(net.writes).toBe(1);
    expect(db.sqlite.prepare('SELECT deleted_at IS NOT NULL AS borrado FROM matches').get()).toEqual({ borrado: 1 });
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(20); // sus acciones no se tocan
    // La comprobación manual completa sigue dando todo por correcto.
    expect((await d.sync.upload(team.id)).status).toBe('verified');
  });

  it('desactivado: no envía; al activarlo envía lo pendiente', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    await d.auto.setEnabled(team.id, false);
    expect((await d.store.getLink(team.id))?.auto).toBe(false);
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(net.writes).toBe(0);
    expect(d.auto.state(team.id).status).toBe('off');
    await d.auto.setEnabled(team.id, true);
    await settle(d.auto, 'synced');
    expect(net.writes).toBe(1);
  });

  it('nunca modifica la base local', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    const before = await local.readAll();
    await settle(d.auto, 'synced');
    expect(await local.readAll()).toEqual(before);
  });
});

describe('activación expresa', () => {
  it('al actualizar la app con un equipo ya vinculado, el envío automático sigue desactivado', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    // Vínculo y envío hechos con la versión anterior (sin preferencia guardada).
    await firstManualUpload(d, { enable: false });
    expect((await d.store.getLink(team.id))?.auto).toBeUndefined();
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    await d.auto.checkAll();
    await new Promise((r) => setTimeout(r, 300));
    expect(d.auto.state(team.id).status).toBe('off');
    expect(net).toMatchObject({ writes: 0, reads: 0 });
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'recovery'")).toBe(0);
  });

  it('activar sin pendientes: no hay nada que confirmar ni que enviar', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d, { enable: false });
    expect(await d.sync.pending(team.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    await d.auto.setEnabled(team.id, true);
    await settle(d.auto, 'synced');
    expect(net.writes).toBe(0);
  });

  it('activar con pendientes: se cuentan antes (sin enviar) y se envían al confirmar', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d, { enable: false });
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[1]!, { period: 1, matchTimeMs: 1000 });
    match = await svc.setScoreAdjustment(local, match, { own: 1, opponent: 0 });
    expect(await d.sync.pending(team.id)).toEqual({ players: 0, matches: 1, events: 2, matchDeletions: 0 });
    expect(net.writes).toBe(0);
    await d.auto.setEnabled(team.id, true);
    await settle(d.auto, 'synced');
    expect(net.writes).toBe(3);
    expect(await d.sync.pending(team.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
  });

  it('la preferencia se recuerda al cerrar y reabrir; desactivar no pierde pendientes', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    d.off();
    const reopened = await deviceSetup(coachToken, 'iphone', 'coach', `cuenta-${n}-iphone`);
    expect((await reopened.store.getLink(team.id))?.auto).toBe(true);
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[0]!, { period: 1, matchTimeMs: 0 });
    await settle(reopened.auto, 'synced');
    expect(net.writes).toBe(1);
    await reopened.auto.setEnabled(team.id, false);
    await svc.recordEvent(local, match, { kind: 'recovery' }, ids[1]!, { period: 1, matchTimeMs: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(net.writes).toBe(1);
    expect((await reopened.sync.pending(team.id)).events).toBe(1); // sigue pendiente para el envío manual
    expect((await reopened.sync.upload(team.id)).status).toBe('verified');
  });

  it('273 acciones históricas ya enviadas: ni se cuentan como pendientes ni se reenvían', async () => {
    for (let i = 20; i < 273; i++) {
      await svc.recordEvent(local, match, { kind: 'shot', shotType: 'six_m', result: i % 3 ? 'goal' : 'saved' }, ids[i % 2]!, { period: 1, matchTimeMs: 0 });
    }
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d, { enable: false });
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(273);
    expect(await d.sync.pending(team.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    await d.auto.setEnabled(team.id, true);
    await settle(d.auto, 'synced');
    await d.auto.checkAll();
    await settle(d.auto, 'synced');
    expect(net).toMatchObject({ writes: 0, reads: 0 });
  });
});

describe('eliminación de un partido sincronizado', () => {
  it('se distingue un partido ya enviado de uno solo local', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d, { enable: false });
    expect(await d.sync.isMatchSynced(match.id)).toBe(true);
    const onlyLocal = await svc.createMatch(local, { teamId: team.id, opponent: 'Amistoso', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: ids });
    expect(await d.sync.isMatchSynced(onlyLocal.id)).toBe(false);
  });

  it('cancelar no borra nada, ni aquí ni en el club', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    const before = await local.readAll();
    // Cancelar en la confirmación = no llamar a deleteMatch.
    await d.auto.checkAll();
    await settle(d.auto, 'synced');
    expect(await local.readAll()).toEqual(before);
    expect(db.sqlite.prepare('SELECT deleted_at FROM matches').get()).toEqual({ deleted_at: null });
  });

  it('confirmado: borrado lógico aquí y en el club, con trazabilidad e idempotencia', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    await svc.deleteMatch(local, match);
    await settle(d.auto, 'synced');
    expect(net.writes).toBe(1);
    expect(db.sqlite.prepare('SELECT deleted_at IS NOT NULL AS borrado, version FROM matches').get()).toEqual({ borrado: 1, version: 2 });
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(20);
    expect((await local.readAll()).events).toHaveLength(20); // las acciones locales tampoco se borran
    await d.auto.checkAll();
    await settle(d.auto, 'synced');
    expect(db.sqlite.prepare('SELECT version FROM matches').get()).toEqual({ version: 2 });
  });

  it('si falla la red al propagar el borrado: queda pendiente y se envía al volver', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d);
    net.down = true;
    await svc.deleteMatch(local, match);
    await waitFor(() => d.auto.state(team.id).status === 'offline');
    expect(db.sqlite.prepare('SELECT deleted_at FROM matches').get()).toEqual({ deleted_at: null });
    expect((await d.sync.pending(team.id)).matchDeletions).toBe(1);
    net.down = false;
    await d.auto.checkAll();
    await settle(d.auto, 'synced');
    expect(db.sqlite.prepare('SELECT deleted_at IS NOT NULL AS borrado FROM matches').get()).toEqual({ borrado: 1 });
  });

  it('un partido solo local se elimina como siempre, sin nada que enviar', async () => {
    const d = await deviceSetup(coachToken, 'iphone');
    await firstManualUpload(d, { enable: false });
    const other = await svc.createMatch(local, { teamId: team.id, opponent: 'Solo aquí', date: '2026-11-02', venue: 'home', season: '2026/27', playerIds: ids });
    await svc.deleteMatch(local, other);
    expect(await d.sync.isMatchSynced(other.id)).toBe(false);
    expect((await d.sync.preview(team.id)).skippedMatches.map((m) => m.id)).toEqual([other.id]);
    expect(await d.sync.pending(team.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    expect(net.writes).toBe(0);
  });
});
