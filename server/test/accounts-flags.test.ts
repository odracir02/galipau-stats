// Interruptores de las cuentas. Con ACCOUNTS_ENABLED distinto de «true», el Worker
// responde exactamente igual que antes (misma respuesta, mismas cabeceras) y no
// existe ninguna ruta nueva. Activado pero mal configurado, responde 503 y no
// arranca nada; la API de dispositivos sigue funcionando en todos los casos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index';
import { accountsEnv, APP, call, ORIGIN, stubTurnstile } from './accountsHarness';
import { addDevice, PEPPER, twoClubs } from './seed';
import { migratedDb } from './sqliteD1';

beforeEach(() => {
  stubTurnstile();
});
afterEach(() => vi.unstubAllGlobals());

interface Probe {
  path: string;
  method?: string;
  body?: unknown;
  origin?: string | null;
  withToken?: boolean;
}

const PROBES: Probe[] = [
  { path: '/api/account/me' },
  { path: '/api/account/me', withToken: true },
  { path: '/api/account/clubs', body: { id: '7b0c1a52-3f43-4c1e-9b7a-0d8c5b4c2a11', name: 'X' }, origin: APP },
  { path: '/api/account/auth/email-otp/send-verification-otp', body: { email: 'a@example.test', type: 'sign-in' }, origin: APP },
  { path: '/api/account/auth/sign-in/email-otp', body: { email: 'a@example.test', otp: '123456' }, origin: ORIGIN },
  { path: '/api/account/auth/get-session' },
  { path: '/api/account/me', method: 'OPTIONS', origin: APP },
  { path: '/api/account', withToken: true },
  { path: '/api/club/A/me' },
  { path: '/api/club/A/me', withToken: true },
  { path: '/api/club/A/me', method: 'OPTIONS', origin: APP },
  { path: '/api/health' },
  { path: '/api/session', withToken: true },
];

async function snapshot(env: Env, token: string) {
  const out = [];
  for (const p of PROBES) {
    const r = await call(env, p.path, {
      method: p.method,
      body: p.body,
      origin: p.origin === undefined ? null : p.origin,
      token: p.withToken ? token : undefined,
      turnstile: null,
      ip: '10.9.9.9',
    });
    out.push({ probe: `${p.method ?? (p.body ? 'POST' : 'GET')} ${p.path}${p.withToken ? ' (token)' : ''}`, status: r.status, body: r.raw, headers: [...r.headers.entries()].filter(([k]) => k !== 'date').sort() });
  }
  return out;
}

async function baseEnv(extra: Partial<Env>): Promise<{ env: Env; token: string }> {
  const db = migratedDb();
  twoClubs(db);
  const { token } = await addDevice(db, 'dev', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
  return { env: { DB: db, TOKEN_PEPPER: PEPPER, ENVIRONMENT: 'test', ALLOWED_ORIGINS: APP, ...extra }, token };
}

describe('ACCOUNTS_ENABLED desactivado', () => {
  it.each(['false', 'TRUE', 'True', '1', 'yes', 'on', '', ' true', undefined])('con «%s» el Worker responde exactamente como sin cuentas', async (value) => {
    const plain = await baseEnv({});
    const reference = await snapshot(plain.env, plain.token);
    // Mismas credenciales de dispositivo en ambos entornos para comparar respuestas.
    const ctx = accountsEnv({ publicSignup: true, db: plain.env.DB as never });
    ctx.env.ACCOUNTS_ENABLED = value;
    const withVars = await snapshot(ctx.env, plain.token);
    expect(withVars).toEqual(reference);
    // Y no se ha escrito nada de cuentas.
    for (const t of ['auth_user', 'auth_session', 'auth_verification', 'auth_rate_limit', 'account_audit']) {
      expect((plain.env.DB as unknown as { sqlite: { prepare(s: string): { get(): unknown } } }).sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
    expect(ctx.mail.sent).toEqual([]);
  });

  it('las rutas de cuentas siguen el camino de siempre: 401 de dispositivo y CORS para la PWA', async () => {
    const { env } = await baseEnv({ ACCOUNTS_ENABLED: 'false' });
    const r = await call(env, '/api/account/me', { origin: APP });
    expect(r.status).toBe(401);
    expect(r.data.error).toBe('unauthorized');
    expect(r.headers.get('access-control-allow-origin')).toBe(APP);
  });
});

describe('ACCOUNTS_ENABLED activado pero incompleto: 503 sin arrancar nada', () => {
  const cases: [string, Partial<Env>][] = [
    ['sin clave de sesión', { BETTER_AUTH_SECRET: undefined }],
    ['clave de sesión corta', { BETTER_AUTH_SECRET: 'corta' }],
    ['sin origen', { ACCOUNTS_ORIGIN: undefined }],
    ['origen con ruta', { ACCOUNTS_ORIGIN: `${ORIGIN}/panel` }],
    ['origen http fuera de local', { ACCOUNTS_ORIGIN: 'http://cuentas.galipau.test', ENVIRONMENT: 'preview' }],
    ['sin Turnstile en preview', { TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined, ENVIRONMENT: 'preview' }],
    ['sin Turnstile en producción', { TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined, ENVIRONMENT: 'production' }],
    ['clave secreta de Turnstile sin clave de sitio', { TURNSTILE_SITE_KEY: undefined }],
    ['clave de sitio de Turnstile sin clave secreta', { TURNSTILE_SECRET_KEY: undefined }],
    ['sin correo fuera de local', { ACCOUNTS_MAILER: undefined, ENVIRONMENT: 'preview' }],
    ['sin TOKEN_PEPPER', { TOKEN_PEPPER: undefined }],
  ];
  it.each(cases)('%s', async (_name, overrides) => {
    const ctx = accountsEnv({ publicSignup: true, overrides });
    const r = await call(ctx.env, '/api/account/auth/email-otp/send-verification-otp', { body: { email: 'a@example.test', type: 'sign-in' } });
    expect(r.status).toBe(503);
    expect(r.data.error).toBe('accounts_not_configured');
    expect(ctx.mail.sent).toEqual([]);
    expect((await call(ctx.env, '/api/health')).status).toBe(200);
  });

  it('en local y pruebas, Turnstile puede faltar (se desactiva) y el origen puede ser localhost', async () => {
    const ctx = accountsEnv({ publicSignup: true, overrides: { TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined } });
    const r = await call(ctx.env, '/api/account/auth/email-otp/send-verification-otp', { body: { email: 'a@example.test', type: 'sign-in' }, turnstile: null });
    expect(r.status).toBe(200);
    expect(ctx.mail.count('a@example.test')).toBe(1);
  });

  it('la API de dispositivos no cambia con las cuentas activadas', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    twoClubs(ctx.db);
    const { token } = await addDevice(ctx.db, 'dev2', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }]);
    const s = await call(ctx.env, '/api/session', { token, host: 'https://api.example' });
    expect(s.status).toBe(200);
    const t = await call(ctx.env, '/api/teams/a1', { token, host: 'https://api.example', origin: APP });
    expect(t.status).toBe(200);
    expect(t.headers.get('access-control-allow-origin')).toBe(APP);
    // En otro host, las rutas de cuentas no existen.
    expect((await call(ctx.env, '/api/account/me', { host: 'https://api.example' })).status).toBe(404);
  });
});
