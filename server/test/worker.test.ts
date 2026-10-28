// Peticiones HTTP completas contra el Worker, con la base de datos de pruebas.
import { beforeEach, describe, expect, it } from 'vitest';
import { ev, goal } from '../../src/test/fixtures';
import worker, { type Env } from '../src/index';
import { addDevice, addMatch, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let env: Env;
const APP = 'https://develop.galipau-stats.pages.dev';

beforeEach(() => {
  db = migratedDb();
  twoClubs(db);
  addMatch(db, 'a1', {}, 'a1-');
  env = { DB: db, TOKEN_PEPPER: PEPPER, ENVIRONMENT: 'test', ALLOWED_ORIGINS: APP };
});

function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  return worker.fetch(new Request(`https://api.example/${path.replace(/^\//, '')}`, { ...init, headers }), env);
}

const syncBody = (opId: string) =>
  JSON.stringify({ opId, teamId: 'a1', baseVersion: null, event: ev(goal(), 'a1-p7', 3, { matchId: 'm1' }) });

describe('API', () => {
  it('health no necesita credencial', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environment: 'test' });
  });

  it('sin credencial o con una inventada: 401', async () => {
    expect((await call('/api/teams/a1')).status).toBe(401);
    expect((await call('/api/teams/a1', { token: 'inventado' })).status).toBe(401);
  });

  it('consulta lee el equipo, pero no puede escribir', async () => {
    const { token } = await addDevice(db, 'v', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }]);
    const res = await call('/api/teams/a1', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ team: { id: 'a1', code: 'SM2627' }, clubId: 'A', role: 'viewer' });

    const write = await call('/api/sync/events', { method: 'POST', token, body: syncBody('op-1') });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: 'forbidden' });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  it('entrenador sube acciones; reintentar devuelve lo mismo', async () => {
    const { token } = await addDevice(db, 'c', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    const body = syncBody('op-1');
    const a = await call('/api/sync/events', { method: 'POST', token, body });
    const b = await call('/api/sync/events', { method: 'POST', token, body });
    expect(a.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    const changes = await call('/api/teams/a1/changes?since=0', { token });
    expect((await changes.json()).events).toHaveLength(1);
  });

  it('equipos de otro equipo o club: 404', async () => {
    const { token } = await addDevice(db, 'c', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect((await call('/api/teams/a1', { token })).status).toBe(200);
    expect((await call('/api/teams/a2', { token })).status).toBe(404);
    expect((await call('/api/teams/b1', { token })).status).toBe(404);
  });

  it('peticiones mal formadas: 400, y nunca se filtran detalles internos', async () => {
    const { token } = await addDevice(db, 'c', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect((await call('/api/sync/events', { method: 'POST', token, body: '{' })).status).toBe(400);
    expect((await call('/api/sync/events', { method: 'POST', token, body: '{}' })).status).toBe(400);
    expect((await call('/api/teams/a1/changes?since=-1', { token })).status).toBe(400);

    const broken: Env = { ...env, DB: { prepare: () => { throw new Error('detalle interno'); }, batch: async () => [] } };
    const res = await worker.fetch(new Request('https://api.example/api/teams/a1', { headers: { Authorization: `Bearer ${token}` } }), broken);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('detalle interno');
  });

  it('CORS solo para el origen de la aplicación', async () => {
    const pre = await call('/api/sync/events', { method: 'OPTIONS', headers: { Origin: APP } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    const other = await call('/api/health', { headers: { Origin: 'https://otra-web.example' } });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('módulo de entrada del Worker', () => {
  it('solo exporta el manejador (el runtime rechaza otras exportaciones con archivos estáticos)', async () => {
    const mod = await import('../src/index');
    expect(Object.keys(mod)).toEqual(['default']);
    expect(typeof mod.default.fetch).toBe('function');
  });
});

