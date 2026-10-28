// Canje de códigos y sesión de dispositivos por HTTP, como lo usará la PWA.
import { beforeEach, describe, expect, it } from 'vitest';
import { createTeam } from '../src/admin';
import worker, { type Env } from '../src/index';
import { REDEEM_LIMIT } from '../src/invites';
import { addAdmin, CODE_KEY, NOW, PEPPER, secrets, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const API = 'https://api.example';
const APP = 'https://develop.galipau-stats.pages.dev';
let db: SqliteD1;
let env: Env;
let ip = 0;
/** Equipos de prueba con sus códigos (base de datos en memoria). */
let sma: { teamId: string; coach: string; viewer: string };
let smb: { teamId: string; coach: string; viewer: string };
let otherClub: { teamId: string; coach: string; viewer: string };

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db);
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: APP };
  const sa = (await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }], { critical: true })).auth;
  const make = async (clubId: string, code: string) => {
    const t = await createTeam(db, sa, { clubId, name: `Equipo ${code}`, code, season: '2026/27' }, await secrets(), new Date(NOW));
    return { teamId: t.teamId, coach: t.codes.coach.code, viewer: t.codes.viewer.code };
  };
  sma = await make('A', 'SMA2627');
  smb = await make('A', 'SMB2627');
  otherClub = await make('B', 'OTR2627');
});

async function call(method: string, path: string, { token, body, headers = {}, ipAddr }: { token?: string; body?: unknown; headers?: Record<string, string>; ipAddr?: string } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': ipAddr ?? `198.51.100.${++ip % 250}`, ...headers });
  if (token) h.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request(`${API}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

const redeem = (code: string, opts: { token?: string; deviceLabel?: unknown; ipAddr?: string; headers?: Record<string, string> } = {}) =>
  call('POST', '/api/invites/redeem', { token: opts.token, ipAddr: opts.ipAddr, headers: opts.headers, body: { code, deviceLabel: opts.deviceLabel } });

describe('canje de códigos', () => {
  it('código de entrenador: dispositivo nuevo, token una sola vez y datos del equipo (sin códigos)', async () => {
    const res = await redeem(sma.coach, { deviceLabel: 'iPhone de pruebas' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'coach', team: { id: sma.teamId, code: 'SMA2627', season: '2026/27', clubId: 'A', clubName: 'Club A' } });
    expect(res.body.token).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toContain(sma.coach);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(db.sqlite.prepare('SELECT label FROM devices WHERE id = ?').get(res.body.deviceId as string)).toEqual({ label: 'iPhone de pruebas' });
    // El token no se guarda en claro.
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM device_tokens').all())).not.toContain(res.body.token as string);
  });

  it('el código de consulta da solo consulta: nunca registrar ni ver el código de entrenador', async () => {
    const res = await redeem(sma.viewer);
    expect(res.body.role).toBe('viewer');
    const token = res.body.token as string;
    expect((await call('GET', `/api/teams/${sma.teamId}`, { token })).body.role).toBe('viewer');
    const sync = await call('POST', '/api/sync/events', { token, body: { opId: 'o1', teamId: sma.teamId, baseVersion: null, event: { id: 'e1' } } });
    expect(sync.status).toBe(403);
    const codes = await call('GET', `/api/teams/${sma.teamId}/codes`, { token });
    expect(codes.body).not.toHaveProperty('coach');
    expect(JSON.stringify(codes.body)).not.toContain(sma.coach);
  });

  it('códigos no válidos, caducados, revocados o de un club suspendido: el mismo 404', async () => {
    expect((await redeem('ABCD-EFGH-JKMN')).body).toMatchObject({ error: 'invalid_code' });
    expect((await redeem('SMA2627')).body).toMatchObject({ error: 'invalid_code' }); // el identificador no es un código
    db.run("UPDATE invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE team_id = ? AND role = 'coach'", sma.teamId);
    expect((await redeem(sma.coach)).status).toBe(404);
    db.run("UPDATE invites SET revoked_at = ? WHERE team_id = ? AND role = 'viewer'", NOW, sma.teamId);
    expect((await redeem(sma.viewer)).status).toBe(404);
    db.run("UPDATE clubs SET status = 'suspended' WHERE id = 'A'");
    expect((await redeem(smb.coach)).status).toBe(404);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
  });

  it('el nombre del dispositivo se guarda sin caracteres de control', async () => {
    const res = await redeem(sma.coach, { deviceLabel: 'iPhone\n\u0000de\u007f Ana\t' });
    expect(db.sqlite.prepare('SELECT label FROM devices WHERE id = ?').get(res.body.deviceId as string)).toEqual({ label: 'iPhonede Ana' });
  });

  it('peticiones mal formadas: 400', async () => {
    expect((await call('POST', '/api/invites/redeem', { body: {} })).status).toBe(400);
    expect((await call('POST', '/api/invites/redeem', { body: { code: 'x'.repeat(41) } })).status).toBe(400);
    expect((await redeem(sma.coach, { deviceLabel: 'x'.repeat(61) })).status).toBe(400);
    expect((await redeem(sma.coach, { deviceLabel: 42 })).status).toBe(400);
    const raw = await worker.fetch(new Request(`${API}/api/invites/redeem`, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }), env);
    expect(raw.status).toBe(400);
  });

  it('sin TOKEN_PEPPER configurado: 503', async () => {
    env = { ...env, TOKEN_PEPPER: undefined };
    expect((await redeem(sma.coach)).status).toBe(503);
  });

  it('límite de intentos por IP de Cloudflare; cabeceras inventadas no lo reinician', async () => {
    for (let i = 0; i < REDEEM_LIMIT.attempts; i++) {
      await redeem('ABCD-EFGH-JKMN', { ipAddr: '203.0.113.50', headers: { 'X-Forwarded-For': `10.0.0.${i}` } });
    }
    expect((await redeem(sma.coach, { ipAddr: '203.0.113.50', headers: { 'X-Forwarded-For': '10.9.9.9' } })).status).toBe(429);
    expect((await redeem(sma.coach, { ipAddr: '203.0.113.51' })).status).toBe(201);
  });
});

describe('varios equipos en un dispositivo', () => {
  it('con su token, un canje añade el equipo con su propio rol; nunca rebaja un rol mayor', async () => {
    const first = await redeem(sma.coach);
    const token = first.body.token as string;
    const second = await redeem(otherClub.viewer, { token });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ deviceId: first.body.deviceId, role: 'viewer' });
    expect(second.body).not.toHaveProperty('token');
    expect((await redeem(sma.viewer, { token })).body.role).toBe('coach');
    const session = await call('GET', '/api/session', { token });
    // Orden: temporada, club y equipo.
    expect((session.body.teams as { code: string; role: string }[]).map((t) => [t.code, t.role])).toEqual([
      ['SMA2627', 'coach'],
      ['OTR2627', 'viewer'],
    ]);
  });

  it('con un token no válido no se crea ningún dispositivo: 401', async () => {
    const res = await redeem(sma.coach, { token: 'inventado' });
    expect(res.status).toBe(401);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
  });

  it('los roles de un equipo no sirven en otro', async () => {
    const token = (await redeem(sma.coach)).body.token as string;
    expect((await call('GET', `/api/teams/${smb.teamId}`, { token })).status).toBe(404);
    expect((await call('GET', `/api/teams/${otherClub.teamId}/codes`, { token })).status).toBe(404);
  });
});

describe('sesión', () => {
  it('lista los equipos del dispositivo y marca como no disponibles los de clubes suspendidos', async () => {
    const token = (await redeem(sma.coach)).body.token as string;
    await redeem(otherClub.viewer, { token });
    db.run("UPDATE clubs SET status = 'suspended' WHERE id = 'B'");
    const res = await call('GET', '/api/session', { token });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.body.teams).toEqual([
      expect.objectContaining({ code: 'SMA2627', role: 'coach', status: 'active', clubName: 'Club A' }),
      expect.objectContaining({ code: 'OTR2627', role: 'viewer', status: 'unavailable', clubName: 'Club B' }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain(token);
    // Listado no significa acceso: el equipo suspendido sigue cerrado.
    expect((await call('GET', `/api/teams/${otherClub.teamId}`, { token })).status).toBe(404);
  });

  it('sin token o con uno inventado: 401', async () => {
    expect((await call('GET', '/api/session')).status).toBe(401);
    expect((await call('GET', '/api/session', { token: 'inventado' })).status).toBe(401);
  });

  it('dejar un equipo retira solo ese acceso, también si el club está suspendido', async () => {
    const token = (await redeem(sma.coach)).body.token as string;
    await redeem(otherClub.viewer, { token });
    db.run("UPDATE clubs SET status = 'suspended' WHERE id = 'B'");
    expect((await call('POST', `/api/session/teams/${otherClub.teamId}/leave`, { token })).status).toBe(200);
    expect((await call('POST', `/api/session/teams/${otherClub.teamId}/leave`, { token })).status).toBe(404);
    const teams = (await call('GET', '/api/session', { token })).body.teams as { code: string }[];
    expect(teams.map((t) => t.code)).toEqual(['SMA2627']);
    expect((await call('GET', `/api/teams/${sma.teamId}`, { token })).status).toBe(200);
  });

  it('cerrar sesión revoca el dispositivo, sus tokens y sus permisos', async () => {
    const first = await redeem(sma.coach);
    const token = first.body.token as string;
    await redeem(smb.viewer, { token });
    expect((await call('POST', '/api/session/logout', { token })).status).toBe(200);
    expect((await call('GET', '/api/session', { token })).status).toBe(401);
    expect((await call('GET', `/api/teams/${sma.teamId}`, { token })).status).toBe(401);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM grants WHERE device_id = ? AND revoked_at IS NULL').get(first.body.deviceId as string)).toEqual({ n: 0 });
    // Volver a entrar exige un canje nuevo (otro dispositivo, otro token).
    const again = await redeem(sma.coach);
    expect(again.status).toBe(201);
    expect(again.body.deviceId).not.toBe(first.body.deviceId);
  });

  it('cerrar la sesión de un dispositivo no afecta a otros dispositivos del mismo equipo', async () => {
    const a = (await redeem(sma.coach)).body.token as string;
    const b = (await redeem(sma.coach)).body.token as string;
    await call('POST', '/api/session/logout', { token: a });
    expect((await call('GET', '/api/session', { token: b })).status).toBe(200);
  });
});

describe('tratamiento de tokens y CORS', () => {
  it('el token solo vale en la cabecera Authorization, nunca en la URL', async () => {
    const token = (await redeem(sma.coach)).body.token as string;
    expect((await call('GET', `/api/session?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await call('GET', `/api/session?access_token=${encodeURIComponent(token)}`)).status).toBe(401);
  });

  it('CORS solo para la app, sin credenciales; preflight de canje y sesión', async () => {
    const pre = await worker.fetch(new Request(`${API}/api/invites/redeem`, { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'POST' } }), env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(pre.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    const ok = await redeem(sma.coach, { headers: { Origin: APP } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    const other = await redeem(sma.viewer, { headers: { Origin: 'https://atacante.example' } });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('las cookies de Access no sirven para la sesión de dispositivo', async () => {
    const res = await call('GET', '/api/session', { headers: { 'Cf-Access-Jwt-Assertion': 'x.y.z', Cookie: 'CF_Authorization=x' } });
    expect(res.status).toBe(401);
  });
});
