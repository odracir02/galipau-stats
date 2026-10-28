// Panel de administración y gestión de clubes, equipos y códigos por HTTP.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { clearJwksCache } from '../src/access';
import worker, { type Env } from '../src/index';
import { ACCESS_ENV, claimsFor, CONFIG, makeIssuer, serveJwks, type Issuer } from './accessKeys';
import { addDevice, CODE_KEY, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const API = 'https://api.example';
const APP = 'https://develop.galipau-stats.pages.dev';
const OWNER = 'propietario@example.com';
let db: SqliteD1;
let env: Env;
let issuer: Issuer;
const served: string[] = [];

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db);
  db.sqlite.exec(buildBootstrapSql({ identityId: 'owner', email: OWNER }));
  issuer = await makeIssuer();
  serveJwks(() => [issuer.jwk]);
  served.length = 0;
  env = {
    DB: db,
    TOKEN_PEPPER: PEPPER,
    INVITE_CODE_KEY: CODE_KEY,
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: APP,
    ...ACCESS_ENV,
    ASSETS: {
      fetch: async (req: Request) => {
        served.push(new URL(req.url).pathname);
        return new Response('<!doctype html><title>Panel</title>', { headers: { 'Content-Type': 'text/html' } });
      },
    },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearJwksCache();
});

/** Petición como el panel: mismo origen, JWT de Access (general o crítico). */
async function admin(path: string, { email = OWNER, critical = false, method = 'GET', body, headers = {} }: { email?: string | null; critical?: boolean; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const h = new Headers({ 'Sec-Fetch-Site': 'same-origin', Origin: API, ...headers });
  if (email) h.set('Cf-Access-Jwt-Assertion', await issuer.sign(claimsFor(email, { aud: critical ? CONFIG.criticalAud : CONFIG.adminAud })));
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request(`${API}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* HTML del panel */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function deviceCall(path: string, token: string, headers: Record<string, string> = {}) {
  const res = await worker.fetch(new Request(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers } }), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

const BURJASSOT_TEAMS = [
  { name: 'Senior Masculino A', code: 'SMA2627', gender: 'male' },
  { name: 'Senior Masculino B', code: 'SMB2627', gender: 'male' },
  { name: 'Senior Femenino A', code: 'SFA2627', gender: 'female' },
  { name: 'Senior Femenino B', code: 'SFB2627', gender: 'female' },
];

describe('panel /admin', () => {
  it('sin Access, sin rol o con método de escritura: no se sirve nada', async () => {
    expect((await admin('/admin/', { email: null })).status).toBe(401);
    expect((await admin('/admin/', { email: 'otro@example.com' })).status).toBe(403);
    expect((await admin('/admin/', { method: 'POST', body: {} })).status).toBe(405);
    env = { ...env, ACCESS_TEAM_DOMAIN: '' };
    expect((await admin('/admin/')).status).toBe(503);
    expect(served).toEqual([]);
  });

  it('con Access y rol: se sirve el panel con cabeceras de seguridad y sin CORS', async () => {
    const res = await admin('/admin/', { headers: { Origin: APP } });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Panel');
    expect(served).toEqual(['/admin/']);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await admin('/admin/assets/app.js')).status).toBe(200);
  });

  it('variantes de ruta del panel no se sirven', async () => {
    for (const p of ['/admin//', '/admin/assets//x.js', '/admin/assets/%2fx.js']) expect((await admin(p)).status, p).toBe(404);
    // «..» lo resuelve el estándar de URLs antes del Worker: es otra ruta, con su propia autenticación.
    expect(new URL(`${API}/admin/%2e%2e/api/admin/me`).pathname).toBe('/api/admin/me');
    expect(served).toEqual([]);
  });

  it('sin archivos estáticos configurados: 503', async () => {
    env = { ...env, ASSETS: undefined };
    expect((await admin('/admin/')).status).toBe(503);
  });

  it('/api/admin/me indica si las escrituras están habilitadas', async () => {
    expect((await admin('/api/admin/me')).body.criticalOpsEnabled).toBe(true);
    env = { ...env, ADMIN_CRITICAL_OPS: 'disabled' };
    expect((await admin('/api/admin/me')).body.criticalOpsEnabled).toBe(false);
  });
});

describe('operaciones críticas desactivadas', () => {
  it('todas las escrituras nuevas responden 503, aunque el token sea crítico', async () => {
    env = { ...env, ADMIN_CRITICAL_OPS: 'disabled' };
    const writes: [string, string, unknown][] = [
      ['PATCH', '/api/admin/critical/clubs/A', { name: 'X' }],
      ['POST', '/api/admin/critical/clubs/A/status', { status: 'suspended' }],
      ['POST', '/api/admin/critical/clubs/A/teams', { name: 'X', code: 'XX2627', season: '2026/27' }],
      ['PATCH', '/api/admin/critical/teams/a1', { name: 'X' }],
      ['POST', '/api/admin/critical/teams/a1/codes/viewer/regenerate', {}],
      ['POST', '/api/admin/critical/teams/a1/codes/coach/revoke', {}],
      ['GET', '/api/admin/critical/reauth?return=/admin/', undefined],
    ];
    for (const [method, path, body] of writes) {
      const res = await admin(path, { critical: true, method, body });
      expect(res.status, `${method} ${path}`).toBe(503);
    }
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM invites").get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare("SELECT status, name FROM clubs WHERE id = 'A'").get()).toEqual({ status: 'active', name: 'Club A' });
  });
});

describe('operaciones críticas habilitadas (solo en pruebas)', () => {
  it('cualquier ruta crítica exige el token de la aplicación crítica', async () => {
    for (const [method, path] of [
      ['PATCH', '/api/admin/critical/clubs/A'],
      ['POST', '/api/admin/critical/clubs/A/teams'],
      ['POST', '/api/admin/critical/teams/a1/codes/viewer/regenerate'],
      ['GET', '/api/admin/critical/reauth'],
    ] as const) {
      expect(await admin(path, { method, body: method === 'GET' ? undefined : {} }), path).toMatchObject({ status: 401, body: { error: 'reauth_required' } });
    }
  });

  it('flujo completo con los datos de referencia del Club Balonmano Burjassot (solo en memoria)', async () => {
    const club = await admin('/api/admin/critical/clubs', { critical: true, method: 'POST', body: { name: 'Club Balonmano Burjassot' } });
    expect(club.status).toBe(201);
    const clubId = club.body.clubId as string;
    for (const t of BURJASSOT_TEAMS) {
      const res = await admin(`/api/admin/critical/clubs/${clubId}/teams`, { critical: true, method: 'POST', body: { ...t, season: '2026/27', category: 'Senior' } });
      expect(res.status, t.code).toBe(201);
    }
    const detail = await admin(`/api/admin/clubs/${clubId}`);
    expect(detail.body).toMatchObject({ name: 'Club Balonmano Burjassot', status: 'active' });
    const teams = detail.body.teams as { code: string; season: string; codes: { coach: boolean; viewer: boolean } }[];
    expect(teams.map((t) => t.code).sort()).toEqual(['SFA2627', 'SFB2627', 'SMA2627', 'SMB2627']);
    expect(teams.every((t) => t.season === '2026/27' && t.codes.coach && t.codes.viewer)).toBe(true);
    // Identificador repetido en el mismo club: 409.
    const dup = await admin(`/api/admin/critical/clubs/${clubId}/teams`, { critical: true, method: 'POST', body: { name: 'Otro', code: 'SMA2627', season: '2026/27' } });
    expect(dup.status).toBe(409);
  });

  it('editar club y equipo, suspender y reactivar (con auditoría)', async () => {
    expect((await admin('/api/admin/critical/clubs/A', { critical: true, method: 'PATCH', body: { name: 'Club A renovado', shortName: 'CA' } })).status).toBe(200);
    expect((await admin('/api/admin/critical/teams/a1', { critical: true, method: 'PATCH', body: { name: 'Senior A', category: 'Senior', gender: 'female' } })).status).toBe(200);
    expect((await admin('/api/admin/critical/clubs/A/status', { critical: true, method: 'POST', body: { status: 'suspended' } })).status).toBe(200);
    expect((await admin('/api/admin/critical/clubs/A/status', { critical: true, method: 'POST', body: { status: 'borrado' } })).status).toBe(400);
    expect((await admin('/api/admin/clubs')).body.clubs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'A', status: 'suspended', name: 'Club A renovado' })]));
    expect((await admin('/api/admin/critical/clubs/A/status', { critical: true, method: 'POST', body: { status: 'active' } })).status).toBe(200);
    expect(db.sqlite.prepare("SELECT name, category, gender FROM teams WHERE id = 'a1'").get()).toEqual({ name: 'Senior A', category: 'Senior', gender: 'female' });
    expect(db.sqlite.prepare('SELECT action FROM admin_audit WHERE action <> ? ORDER BY seq').all('superadmin.bootstrap').map((r) => r.action)).toEqual([
      'club.update',
      'team.update',
      'club.suspend',
      'club.reactivate',
    ]);
  });

  it('el administrador de club gestiona su club pero no cambia su estado ni toca otro club', async () => {
    await admin('/api/admin/critical/clubs/A/admins', { critical: true, method: 'POST', body: { email: 'presi@a.example' } });
    const as = { email: 'presi@a.example', critical: true };
    expect((await admin('/api/admin/critical/clubs/A', { ...as, method: 'PATCH', body: { name: 'Nuevo nombre' } })).status).toBe(200);
    expect((await admin('/api/admin/critical/clubs/A/teams', { ...as, method: 'POST', body: { name: 'Cadete', code: 'CAD2627', season: '2026/27' } })).status).toBe(201);
    expect((await admin('/api/admin/critical/clubs/A/status', { ...as, method: 'POST', body: { status: 'suspended' } })).status).toBe(403);
    expect((await admin('/api/admin/critical/clubs/B', { ...as, method: 'PATCH', body: { name: 'X' } })).status).toBe(404);
    expect((await admin('/api/admin/critical/teams/b1/codes/viewer/regenerate', { ...as, method: 'POST', body: {} })).status).toBe(404);
    expect((await admin('/api/admin/clubs/B', { email: 'presi@a.example' })).status).toBe(404);
  });

  it('regenerar y revocar por HTTP afecta solo al tipo indicado; un rol inventado es 404', async () => {
    const created = await admin('/api/admin/critical/clubs/A/teams', { critical: true, method: 'POST', body: { name: 'Equipo', code: 'EQ2627', season: '2026/27' } });
    const teamId = created.body.teamId as string;
    const original = created.body.codes as Record<string, { code: string }>;
    const regen = await admin(`/api/admin/critical/teams/${teamId}/codes/viewer/regenerate`, { critical: true, method: 'POST', body: {} });
    expect(regen.status).toBe(201);
    const codes = await admin(`/api/admin/teams/${teamId}/codes`);
    expect(codes.body).toMatchObject({ teamCode: 'EQ2627', coach: { code: original.coach!.code }, viewer: { code: regen.body.code } });
    expect((await admin(`/api/admin/critical/teams/${teamId}/codes/coach/revoke`, { critical: true, method: 'POST', body: {} })).status).toBe(200);
    expect((await admin(`/api/admin/teams/${teamId}/codes`)).body).toMatchObject({ coach: null, viewer: { code: regen.body.code } });
    expect((await admin(`/api/admin/critical/teams/${teamId}/codes/admin/regenerate`, { critical: true, method: 'POST', body: {} })).status).toBe(404);
  });

  it('la vuelta tras la verificación solo lleva a rutas del panel', async () => {
    const ok = await worker.fetch(
      new Request(`${API}/api/admin/critical/reauth?return=${encodeURIComponent('/admin/#/clubs/A')}`, {
        headers: { 'Cf-Access-Jwt-Assertion': await issuer.sign(claimsFor(OWNER, { aud: CONFIG.criticalAud })) },
      }),
      env,
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get('Location')).toBe('/admin/#/clubs/A');
    for (const bad of ['https://atacante.example', '//atacante.example', '/api/admin/me', '/admin/../x', 'javascript:alert(1)', '/admin//x']) {
      const res = await worker.fetch(
        new Request(`${API}/api/admin/critical/reauth?return=${encodeURIComponent(bad)}`, {
          headers: { 'Cf-Access-Jwt-Assertion': await issuer.sign(claimsFor(OWNER, { aud: CONFIG.criticalAud })) },
        }),
        env,
      );
      expect(res.headers.get('Location'), bad).toBe('/admin/');
    }
  });
});

describe('códigos desde la PWA (dispositivos)', () => {
  let teamId: string;

  beforeEach(async () => {
    const created = await admin('/api/admin/critical/clubs/A/teams', { critical: true, method: 'POST', body: { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27' } });
    teamId = created.body.teamId as string;
  });

  it('entrenador ve los dos; consulta solo el suyo; con CORS para la PWA, sin credenciales y sin caché', async () => {
    const coach = await addDevice(db, 'coach', [{ clubId: 'A', teamId, role: 'coach' }]);
    const viewer = await addDevice(db, 'viewer', [{ clubId: 'A', teamId, role: 'viewer' }]);
    const c = await deviceCall(`/api/teams/${teamId}/codes`, coach.token, { Origin: APP });
    expect(c.status).toBe(200);
    expect(c.body).toHaveProperty('coach.code');
    expect(c.body).toHaveProperty('viewer.code');
    expect(c.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(c.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(c.headers.get('Cache-Control')).toBe('no-store');
    const v = await deviceCall(`/api/teams/${teamId}/codes`, viewer.token, { Origin: APP });
    expect(v.body).not.toHaveProperty('coach');
    expect(v.body).toHaveProperty('viewer.code');
  });

  it('otro origen no recibe cabeceras CORS; sin token o con otro equipo, nada', async () => {
    const coach = await addDevice(db, 'coach', [{ clubId: 'A', teamId, role: 'coach' }]);
    const other = await addDevice(db, 'other', [{ clubId: 'A', teamId: 'a2', role: 'coach' }]);
    const res = await deviceCall(`/api/teams/${teamId}/codes`, coach.token, { Origin: 'https://atacante.example' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await deviceCall(`/api/teams/${teamId}/codes`, 'inventado')).status).toBe(401);
    expect((await deviceCall(`/api/teams/${teamId}/codes`, other.token)).status).toBe(404);
  });

  it('las cookies de Access no sirven aquí: sin token de dispositivo es 401', async () => {
    const res = await worker.fetch(
      new Request(`${API}/api/teams/${teamId}/codes`, { headers: { 'Cf-Access-Jwt-Assertion': await issuer.sign(claimsFor(OWNER)) } }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('sin clave de cifrado configurada: 503, sin filtrar nada', async () => {
    const coach = await addDevice(db, 'coach', [{ clubId: 'A', teamId, role: 'coach' }]);
    env = { ...env, INVITE_CODE_KEY: undefined };
    const res = await deviceCall(`/api/teams/${teamId}/codes`, coach.token);
    expect(res).toMatchObject({ status: 503, body: { error: 'codes_unavailable' } });
    expect((await admin(`/api/admin/teams/${teamId}/codes`)).status).toBe(503);
  });
});
