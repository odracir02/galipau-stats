// Rutas de administración de extremo a extremo: JWT de Access firmado con
// claves reales de prueba + roles en la base de datos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { clearJwksCache } from '../src/access';
import { authenticateAdmin } from '../src/auth';
import worker, { type Env } from '../src/index';
import { ACCESS_ENV, claimsFor, CONFIG, makeIssuer, serveJwks, type Issuer } from './accessKeys';
import { addDevice, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let env: Env;
let issuer: Issuer;
const APP = 'https://develop.galipau-stats.pages.dev';
const OWNER = 'propietario@example.com';

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db);
  db.sqlite.exec(buildBootstrapSql({ identityId: 'owner', email: OWNER }));
  issuer = await makeIssuer();
  serveJwks(() => [issuer.jwk]);
  env = { DB: db, TOKEN_PEPPER: PEPPER, ENVIRONMENT: 'test', ALLOWED_ORIGINS: APP, ...ACCESS_ENV };
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearJwksCache();
});

async function call(path: string, { email, critical = false, method = 'GET', body, headers = {} }: {
  email?: string;
  critical?: boolean;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const h = new Headers(headers);
  if (email) h.set('Cf-Access-Jwt-Assertion', await issuer.sign(claimsFor(email, { aud: critical ? CONFIG.criticalAud : CONFIG.adminAud })));
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(
    new Request(`https://api.example${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

describe('acceso a la administración', () => {
  it('sin configuración de Access, la administración está desactivada en cualquier entorno', async () => {
    env = { DB: db, TOKEN_PEPPER: PEPPER, ENVIRONMENT: 'local', ALLOWED_ORIGINS: APP, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD_ADMIN: '', ACCESS_AUD_CRITICAL: '' };
    expect((await call('/api/admin/me', { email: OWNER })).body).toMatchObject({ error: 'admin_disabled' });
    expect((await call('/api/admin/me', { email: OWNER })).status).toBe(503);
  });

  it('sin autenticar: 401', async () => {
    expect(await call('/api/admin/me')).toMatchObject({ status: 401, body: { error: 'access_required' } });
    expect(await call('/api/admin/me', { headers: { 'Cf-Access-Jwt-Assertion': 'falso.falso.falso' } })).toMatchObject({ status: 401 });
  });

  it('un token de dispositivo (entrenador) no sirve para administrar', async () => {
    const { token } = await addDevice(db, 'coach', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect((await call('/api/admin/me', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('autenticado por Access pero sin rol en la base de datos: 403', async () => {
    expect(await call('/api/admin/me', { email: 'desconocido@example.com' })).toMatchObject({ status: 403, body: { error: 'not_admin' } });
  });

  it('el superadministrador ve su perfil y todos los clubes', async () => {
    expect((await call('/api/admin/me', { email: OWNER })).body).toMatchObject({
      identityId: 'owner',
      email: OWNER,
      roles: [{ role: 'superadmin', clubId: null }],
    });
    const clubs = await call('/api/admin/clubs', { email: OWNER });
    expect((clubs.body.clubs as { id: string }[]).map((c) => c.id)).toEqual(['A', 'B']);
  });
});

describe('operaciones críticas', () => {
  it('exigen el token de la aplicación crítica, además del rol', async () => {
    expect(await call('/api/admin/critical/clubs', { email: OWNER, method: 'POST', body: { name: 'Club C' } })).toMatchObject({
      status: 401,
      body: { error: 'reauth_required' },
    });
    const ok = await call('/api/admin/critical/clubs', { email: OWNER, critical: true, method: 'POST', body: { name: 'Club C' } });
    expect(ok.status).toBe(201);
    expect(db.sqlite.prepare('SELECT name FROM clubs WHERE id = ?').get(ok.body.clubId as string)).toEqual({ name: 'Club C' });
  });

  it('nombrar y retirar un administrador de club; su acceso cambia en la siguiente petición', async () => {
    const appoint = await call('/api/admin/critical/clubs/A/admins', {
      email: OWNER,
      critical: true,
      method: 'POST',
      body: { email: 'presi@club-a.example', displayName: 'Presidencia A', role: 'superadmin' },
    });
    expect(appoint.status).toBe(201);
    // El campo «role» inyectado se ignora: siempre es administrador de ese club.
    expect(db.sqlite.prepare("SELECT role, club_id FROM admin_roles WHERE identity_id = ?").all(appoint.body.identityId as string)).toEqual([
      { role: 'club_admin', club_id: 'A' },
    ]);

    const me = await call('/api/admin/me', { email: 'presi@club-a.example' });
    expect(me.body.roles).toEqual([{ role: 'club_admin', clubId: 'A' }]);
    const clubs = await call('/api/admin/clubs', { email: 'presi@club-a.example' });
    expect((clubs.body.clubs as { id: string }[]).map((c) => c.id)).toEqual(['A']);

    const revoke = await call(`/api/admin/critical/clubs/A/admins/${appoint.body.identityId as string}`, { email: OWNER, critical: true, method: 'DELETE' });
    expect(revoke.status).toBe(200);
    expect((await call('/api/admin/me', { email: 'presi@club-a.example' })).status).toBe(403);
  });

  it('un administrador de club no puede crear clubes ni nombrar administradores, ni con token crítico', async () => {
    await call('/api/admin/critical/clubs/A/admins', { email: OWNER, critical: true, method: 'POST', body: { email: 'presi@club-a.example' } });
    const as = { email: 'presi@club-a.example', critical: true };
    expect((await call('/api/admin/critical/clubs', { ...as, method: 'POST', body: { name: 'Pirata' } })).status).toBe(403);
    expect((await call('/api/admin/critical/clubs/A/admins', { ...as, method: 'POST', body: { email: 'amigo@example.com' } })).status).toBe(403);
    expect((await call('/api/admin/critical/clubs/B/admins', { ...as, method: 'POST', body: { email: 'presi@club-a.example' } })).status).toBe(404);
    expect((await call('/api/admin/critical/clubs/A', { ...as, method: 'DELETE' })).status).toBe(403);
  });

  it('la vinculación de la cuenta impide suplantar a una identidad con otra cuenta del mismo correo', async () => {
    expect((await call('/api/admin/me', { email: OWNER })).status).toBe(200);
    const h = { 'Cf-Access-Jwt-Assertion': await issuer.sign(claimsFor(OWNER, { sub: 'otra-cuenta' })) };
    expect(await call('/api/admin/me', { headers: h })).toMatchObject({ status: 403, body: { error: 'identity_mismatch' } });
  });
});

describe('separación de la API de administración', () => {
  it('nunca envía cabeceras CORS ni permite credenciales cruzadas', async () => {
    const res = await call('/api/admin/me', { email: OWNER, headers: { Origin: APP } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    const pre = await worker.fetch(new Request('https://api.example/api/admin/me', { method: 'OPTIONS', headers: { Origin: APP } }), env);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rutas desconocidas de administración: 404 tras autenticar', async () => {
    expect((await call('/api/admin/nada', { email: OWNER })).status).toBe(404);
    expect((await call('/api/admin/nada')).status).toBe(401);
  });
});

describe('operaciones críticas desactivadas (valor por defecto)', () => {
  beforeEach(() => {
    env = { ...env, ADMIN_CRITICAL_OPS: 'disabled' };
  });

  it('responden 503 aunque el token sea de la aplicación crítica y el rol sea superadministrador', async () => {
    const res = await call('/api/admin/critical/clubs', { email: OWNER, critical: true, method: 'POST', body: { name: 'Club C' } });
    expect(res).toMatchObject({ status: 503, body: { error: 'critical_disabled' } });
    const appoint = await call('/api/admin/critical/clubs/A/admins', { email: OWNER, critical: true, method: 'POST', body: { email: 'x@example.com' } });
    expect(appoint.status).toBe(503);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM admin_roles').get()).toEqual({ n: 1 });
  });

  it('ningún token cuenta como crítico mientras estén desactivadas (también fuera de las rutas)', async () => {
    const token = await issuer.sign(claimsFor(OWNER, { aud: CONFIG.criticalAud }));
    const req = new Request('https://api.example/api/admin/me', { headers: { 'Cf-Access-Jwt-Assertion': token } });
    const auth = await authenticateAdmin(db, req, { ...CONFIG, criticalEnabled: false });
    expect(auth.admin?.critical).toBe(false);
    expect((await authenticateAdmin(db, req, CONFIG)).admin?.critical).toBe(true);
  });

  it('el resto de la administración sigue funcionando', async () => {
    expect((await call('/api/admin/me', { email: OWNER, critical: true })).status).toBe(200);
  });
});

describe('peticiones que llegan al Worker sin pasar por Access', () => {
  it('sin token, con token de otra aplicación o de otro equipo de Access: 401', async () => {
    expect((await call('/api/admin/me')).status).toBe(401);
    // Token auténtico del mismo equipo pero de otra aplicación (p. ej. la de otro entorno).
    const otherApp = await issuer.sign(claimsFor(OWNER, { aud: 'aud-de-la-aplicacion-de-preview-000' }));
    expect((await call('/api/admin/me', { headers: { 'Cf-Access-Jwt-Assertion': otherApp } })).status).toBe(401);
    // Token firmado por otra clave (otro equipo de Access o un atacante).
    const outsider = await makeIssuer('clave-ajena');
    const foreign = await outsider.sign(claimsFor(OWNER, { iss: 'https://otro-equipo.cloudflareaccess.com' }));
    expect((await call('/api/admin/me', { headers: { 'Cf-Access-Jwt-Assertion': foreign } })).status).toBe(401);
  });

  it('un token de la aplicación general no sirve para la ruta crítica, aunque se llegue directamente', async () => {
    const res = await call('/api/admin/critical/clubs', { email: OWNER, method: 'POST', body: { name: 'X' } });
    expect(res).toMatchObject({ status: 401, body: { error: 'reauth_required' } });
  });

  it('variantes de ruta (barras dobles, finales o codificadas, puntos) no se enrutan', async () => {
    for (const path of [
      '/api//admin/me',
      '/api/admin//me',
      '/api/admin/me/',
      '/api/admin//critical/clubs',
      '/api/admin%2Fcritical/clubs',
      '/API/admin/me',
    ]) {
      const res = await worker.fetch(new Request(`https://api.example${path}`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': 'x' } }), env);
      expect(res.status, path).toBe(404);
    }
    // Los segmentos «..» (también codificados) los resuelve el analizador de URLs
    // antes del Worker: la ruta resultante se trata como tal, con su propia
    // autenticación. Aquí acaba en una ruta de dispositivo, que exige su token.
    const dots = await worker.fetch(new Request('https://api.example/api/admin/%2e%2e/teams/a1', { headers: { 'Cf-Access-Jwt-Assertion': 'x' } }), env);
    expect(new URL('https://api.example/api/admin/%2e%2e/teams/a1').pathname).toBe('/api/teams/a1');
    expect(await dots.json()).toMatchObject({ error: 'unauthorized' });
  });
});

describe('Access general configurado sin aplicación crítica (estado actual de preview)', () => {
  beforeEach(() => {
    env = { ...env, ACCESS_AUD_CRITICAL: '', ADMIN_CRITICAL_OPS: 'enabled' };
  });

  it('la administración general funciona; las operaciones críticas siguen desactivadas', async () => {
    expect((await call('/api/admin/me', { email: OWNER })).status).toBe(200);
    const res = await call('/api/admin/critical/clubs', { email: OWNER, critical: true, method: 'POST', body: { name: 'X' } });
    expect(res).toMatchObject({ status: 503, body: { error: 'critical_disabled' } });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM clubs").get()).toEqual({ n: 2 });
  });
});

