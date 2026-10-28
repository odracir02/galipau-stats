// El Worker de preview tal como quedará justo después del primer despliegue:
// variables reales de wrangler.jsonc (las dos aplicaciones de Access
// configuradas, operaciones críticas desactivadas), base de datos migrada y,
// al principio, sin TOKEN_PEPPER.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessConfig, clearJwksCache } from '../src/access';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { MIN_PEPPER_LENGTH } from '../src/app';
import worker, { type Env } from '../src/index';
import { addDevice, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const wrangler = JSON.parse(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n'),
) as { env: { preview: { vars: Record<string, string> } } };
const PREVIEW_VARS = wrangler.env.preview.vars;
const OWNER = 'propietario@example.com';

let db: SqliteD1;
let env: Env;

beforeEach(() => {
  db = migratedDb();
  twoClubs(db);
  db.sqlite.exec(buildBootstrapSql({ identityId: 'owner', email: OWNER }));
  // Sin TOKEN_PEPPER: aún no se ha ejecutado «wrangler secret put».
  env = { DB: db, ...PREVIEW_VARS } as unknown as Env;
  // Nada de red en las pruebas: si se intentara pedir claves a Access, fallaría.
  clearJwksCache();
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Sin red en las pruebas');
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearJwksCache();
});

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://galipau-stats-api-preview.example.workers.dev${path}`, init), env);

const snapshot = () =>
  JSON.stringify(
    ['admin_identities', 'admin_roles', 'admin_audit', 'clubs', 'teams', 'devices', 'grants', 'events'].map((t) =>
      db.sqlite.prepare(`SELECT * FROM ${t}`).all(),
    ),
  );

const ADMIN_REQUESTS: [string, string, unknown?][] = [
  ['GET', '/api/admin/me'],
  ['GET', '/api/admin/clubs'],
  ['GET', '/api/admin/nada'],
  ['POST', '/api/admin/critical/clubs', { name: 'Club pirata' }],
  ['DELETE', '/api/admin/critical/clubs/A'],
  ['POST', '/api/admin/critical/clubs/A/admins', { email: 'atacante@example.com', role: 'superadmin' }],
  ['DELETE', '/api/admin/critical/clubs/A/admins/owner'],
];

describe('Worker de preview (Access configurado, operaciones críticas desactivadas)', () => {
  it('preview tiene las dos aplicaciones de Access y ninguna operación crítica habilitada', () => {
    expect(PREVIEW_VARS).toMatchObject({
      ENVIRONMENT: 'preview',
      ACCESS_TEAM_DOMAIN: 'https://shiny-star-4f59.cloudflareaccess.com',
      ADMIN_CRITICAL_OPS: 'disabled',
    });
    expect(PREVIEW_VARS).not.toHaveProperty('TOKEN_PEPPER');
    const config = accessConfig(PREVIEW_VARS);
    expect(config).toMatchObject({ teamDomain: 'https://shiny-star-4f59.cloudflareaccess.com', criticalEnabled: false });
    // Dos AUD válidos y distintos: el verificador acepta la aplicación crítica.
    expect(config?.adminAud).toMatch(/^[0-9a-f]{64}$/);
    expect(config?.criticalAud).toMatch(/^[0-9a-f]{64}$/);
    expect(config?.criticalAud).not.toBe(config?.adminAud);
    expect(config?.criticalAud).toBe(PREVIEW_VARS.ACCESS_AUD_CRITICAL);
    // Con la aplicación crítica configurada, solo ADMIN_CRITICAL_OPS las mantiene desactivadas.
    expect(accessConfig({ ...PREVIEW_VARS, ADMIN_CRITICAL_OPS: 'enabled' })?.criticalEnabled).toBe(true);
  });

  it('/api/health funciona sin ninguna configuración', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environment: 'preview' });
  });

  it('sin un JWT de Access válido, la administración responde 401 (y las críticas 503), sin datos y sin escribir nada', async () => {
    const before = snapshot();
    const forged: Record<string, string>[] = [
      {},
      { 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6InByb3BpZXRhcmlvQGV4YW1wbGUuY29tIn0.' },
      { 'Cf-Access-Authenticated-User-Email': OWNER },
      { Authorization: 'Bearer inventado' },
    ];
    for (const headers of forged) {
      for (const [method, path, body] of ADMIN_REQUESTS) {
        const res = await call(path, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        expect(res.status, `${method} ${path}`).toBe(path.startsWith('/api/admin/critical') ? 503 : 401);
        expect(Object.keys(JSON.parse(text)).sort()).toEqual(['error', 'message']);
        expect(text).not.toContain(OWNER);
        expect(text).not.toContain('owner');
      }
    }
    expect(snapshot()).toBe(before);
  });

  it('las rutas de dispositivos se rechazan (503) mientras falte TOKEN_PEPPER, sin consultar la base de datos', async () => {
    const touched: string[] = [];
    env = { ...env, DB: { prepare: (q: string) => (touched.push(q), db.prepare(q)), batch: (s) => db.batch(s) } };
    for (const [method, path] of [
      ['GET', '/api/teams/a1'],
      ['GET', '/api/teams/a1/changes?since=0'],
      ['POST', '/api/sync/events'],
      ['GET', '/api/lo-que-sea'],
    ] as const) {
      const res = await call(path, { method, headers: { Authorization: 'Bearer inventado' } });
      expect(res.status, path).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'not_configured' });
    }
    expect(touched).toEqual([]);
  });

  it('una clave demasiado corta cuenta como no configurada', async () => {
    env = { ...env, TOKEN_PEPPER: 'x'.repeat(MIN_PEPPER_LENGTH - 1) };
    expect((await call('/api/teams/a1', { headers: { Authorization: 'Bearer x' } })).status).toBe(503);
  });

  it('con TOKEN_PEPPER configurado, las rutas de dispositivos siguen exigiendo credencial y permiso', async () => {
    env = { ...env, TOKEN_PEPPER: PEPPER };
    expect((await call('/api/teams/a1')).status).toBe(401);
    expect((await call('/api/teams/a1', { headers: { Authorization: 'Bearer inventado' } })).status).toBe(401);
    const { token } = await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }]);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await call('/api/teams/a1', { headers: auth })).status).toBe(200);
    expect((await call('/api/teams/b1', { headers: auth })).status).toBe(404);
    expect((await call('/api/sync/events', { method: 'POST', headers: auth, body: '{"opId":"o","teamId":"a1","event":{"id":"e"}}' })).status).toBe(403);
    // Un token de dispositivo no sirve para administrar.
    expect((await call('/api/admin/me', { headers: auth })).status).toBe(401);
  });
});
