// La PWA publicada (que no conoce el cuerpo técnico) ante un equipo que ya tiene
// oficiales: el servidor responde 503 update_required y la PWA, con su código
// actual, lo trata como un fallo temporal. Contra el Worker real en memoria;
// datos y códigos sintéticos.
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
import { TeamImporter } from '../../src/remote/importer';
import { TeamPuller } from '../../src/remote/pull';
import { AccountStore } from '../../src/remote/store';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, NOW, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
let n = 0;
let db: SqliteD1;
let env: Env;
let team: Team;
let match: Match;
let ids: string[];
let tokenA: string;
let A: Awaited<ReturnType<typeof device>>;
const autos: AutoSync[] = [];

const remoteTeam: RemoteTeam = { teamId: REMOTE, role: 'coach', status: 'active', name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', clubId: 'A', clubName: 'Club A' };

/** Dispositivo con la PWA actual; `nueva` añade la cabecera de la versión que conoce los oficiales. */
async function device(name: string, token: string, { nueva = false, storeName = `cuenta-${n}-${name}`, localName = `local-${n}-${name}` } = {}) {
  const local = new IndexedDbRepository(localName);
  const repo = new ObservableRepository(local);
  const store = new AccountStore(storeName);
  await store.saveDevice({ deviceId: name, token, joinedAt: NOW });
  const net = { requests: [] as number[] };
  const api: Api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      net.requests.push(Date.now());
      const headers = { ...(init?.headers as Record<string, string>), ...(nueva && { 'X-GalipauStats-Features': 'officials' }) };
      return worker.fetch(new Request(input as string, { ...init, headers }), env);
    },
  });
  const teams = () => [remoteTeam];
  const importer = new TeamImporter(local, store, api, teams);
  await importer.load();
  const sync = new ClubSync(repo, store, api, teams);
  const puller = new TeamPuller(local, store, api, teams);
  return { name, local, repo, store, net, api, importer, sync, puller };
}

const countRows = (sql: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('No se cumplió la condición a tiempo');
}

/** La versión nueva da de alta un oficial en el equipo del club (por HTTP). */
async function addOfficial(token: string) {
  const res = await worker.fetch(
    new Request('https://api.example/api/sync/players', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GalipauStats-Features': 'officials' },
      body: JSON.stringify({
        opId: 'alta-oficial',
        teamId: REMOTE,
        baseVersion: null,
        player: { id: 'oficial-1', teamId: REMOTE, name: 'Segundo entrenador', number: 0, position: 'field', active: true, createdAt: NOW, updatedAt: NOW, role: 'official' },
      }),
    }),
    env,
  );
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  tokenA = (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token;
  // El iPhone (versión publicada) con su equipo vinculado y enviado.
  A = await device('iphone', tokenA);
  team = await createTeam(A.repo, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
  ids = [];
  for (const [num, pos] of [[7, 'field'], [9, 'field'], [1, 'goalkeeper']] as const) {
    ids.push((await savePlayer(A.repo, team.id, { name: `Jugador ${num}`, number: num, position: pos, active: true })).id);
  }
  match = await svc.createMatch(A.repo, { teamId: team.id, opponent: 'Rival', date: '2026-10-31', venue: 'home', season: '2026/27', playerIds: ids });
  for (let i = 0; i < 5; i++) await svc.recordEvent(A.repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, ids[0]!, { period: 1, matchTimeMs: i * 1000 });
  match = await svc.finishMatch(A.repo, match);
  await A.sync.link(team.id, REMOTE);
  expect((await A.sync.upload(team.id)).status).toBe('verified');
  // Como el iPhone real: el envío automático ya adoptado (005E.2L).
  await A.store.updateLink({ ...(await A.store.getLink(team.id))!, auto: true });
  // Otro entrenador, ya con la versión nueva, da de alta a un oficial.
  await addOfficial((await addDevice(db, 'nuevo', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token);
});

afterEach(async () => {
  for (const a of autos.splice(0)) await a.dispose();
});

describe('PWA publicada en un equipo con oficiales', () => {
  it('envío automático: queda «Sin conexión», conserva lo pendiente y reintenta con esperas crecientes', async () => {
    const before = await A.local.readAll();
    const recorded = await svc.recordEvent(A.repo, (await A.local.getMatch(match.id))!, { kind: 'recovery' }, ids[1]!, { period: 1, matchTimeMs: 9000 });
    const auto = new AutoSync(A.sync, A.store, A.api, () => [remoteTeam], { quietMs: 10, maxWaitMs: 50, retryMs: [100, 200, 400, 800] });
    autos.push(auto);
    const off = A.repo.onChange((c) => c.entity !== 'team' && auto.changed(c.teamId));
    A.net.requests.length = 0;
    await auto.checkAll();
    await waitFor(() => auto.state(team.id).status === 'offline');
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 1200));
    off();
    // Reintentos espaciados (100, 200, 400, 800 ms), no en bucle.
    const attempts = A.net.requests.filter((t) => t >= start).length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(4);
    // Nada bloqueado ni perdido: el envío sigue pendiente y la base local intacta (más la acción nueva).
    const link = (await A.store.getLink(team.id))!;
    expect(link.autoBlocked ?? null).toBeNull();
    expect(link.accessLost ?? false).toBe(false);
    expect(link.readOnly ?? false).toBe(false);
    expect((await A.sync.pending(team.id)).events).toBe(1);
    expect(await A.local.getEvent(recorded.id)).toBeDefined();
    const after = await A.local.readAll();
    expect(after.players).toEqual(before.players);
    expect(after.events.length).toBe(before.events.length + 1);
    expect(countRows(`events WHERE id = '${recorded.id}'`)).toBe(0);
    expect(await A.store.getDevice()).toMatchObject({ deviceId: 'iphone' });
  });

  it('envío manual: se detiene como sin conexión, sin cambiar nada; recibir cambios: error, sin tocar la copia', async () => {
    await svc.recordEvent(A.repo, (await A.local.getMatch(match.id))!, { kind: 'recovery' }, ids[1]!, { period: 1, matchTimeMs: 9000 });
    const out = await A.sync.upload(team.id);
    expect(out).toMatchObject({ status: 'stopped', stop: { reason: 'offline' } });
    const before = await A.local.readAll();
    const linkBefore = await A.store.getLink(team.id);
    const pulled = await A.puller.pull(team.id);
    expect(pulled.status).toBe('error');
    expect(await A.local.readAll()).toEqual(before);
    expect(await A.store.getLink(team.id)).toEqual(linkBefore);
    // Ningún oficial ha llegado a la base local.
    expect(before.players.some((p) => p.id === 'oficial-1')).toBe(false);
  });

  it('un dispositivo nuevo con la versión publicada no incorpora el equipo ni crea nada; lo reintenta más tarde', async () => {
    const tokenB = (await addDevice(db, 'portatil', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token;
    const B = await device('portatil', tokenB);
    await B.importer.incorporate();
    expect(B.importer.incorporationOf(REMOTE)).toMatchObject({ status: 'error' });
    expect((await B.local.readAll()).teams).toHaveLength(0);
    expect(await B.store.listLinks()).toEqual([]);
  });

  it('cerrar y reabrir la PWA antigua con pendientes: sigue igual; al actualizar se envía una sola vez', async () => {
    const recorded = await svc.recordEvent(A.repo, (await A.local.getMatch(match.id))!, { kind: 'recovery' }, ids[1]!, { period: 1, matchTimeMs: 9000 });
    expect((await A.sync.upload(team.id)).status).toBe('stopped');
    // Reapertura con la misma versión.
    const again = await device('iphone', tokenA, { storeName: `cuenta-${n}-iphone`, localName: `local-${n}-iphone` });
    const auto = new AutoSync(again.sync, again.store, again.api, () => [remoteTeam], { quietMs: 10, maxWaitMs: 50, retryMs: [5000] });
    autos.push(auto);
    await auto.checkAll();
    await waitFor(() => auto.state(team.id).status === 'offline');
    expect((await again.sync.pending(team.id)).events).toBe(1);
    // Tras actualizar (la versión nueva declara que conoce los oficiales): se envía.
    // Aquí la «versión nueva» es la actual con la cabecera: aún no guarda los
    // oficiales en el dispositivo (eso es la PWA de C3), así que la comprobación
    // final solo señala al oficial como diferencia; lo propio se envía igual.
    const updated = await device('iphone', tokenA, { nueva: true, storeName: `cuenta-${n}-iphone`, localName: `local-${n}-iphone` });
    const first = await updated.sync.upload(team.id);
    expect(first.status).not.toBe('stopped');
    expect(first.differences.every((d) => d.includes('Segundo entrenador'))).toBe(true);
    expect(countRows(`events WHERE id = '${recorded.id}'`)).toBe(1);
    expect((await updated.sync.pending(team.id)).events).toBe(0);
    expect((await updated.sync.upload(team.id)).status).not.toBe('stopped');
    expect(countRows(`events WHERE id = '${recorded.id}'`)).toBe(1);
    expect(countRows(`sync_ops WHERE entity_id = '${recorded.id}'`)).toBe(1);
  });
});
