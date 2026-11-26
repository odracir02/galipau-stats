// Compatibilidad con la biblioteca de autenticación: la migración 0008 contiene
// exactamente el esquema que genera la versión fijada, y la configuración de
// seguridad está escrita de forma explícita (sin depender de valores por defecto).
import { readFileSync } from 'node:fs';
import { getMigrations } from 'better-auth/db/migration';
import { describe, expect, it } from 'vitest';
import { authOptions, AUTH_COOKIE_PATH, SESSION_SECONDS } from '../src/accounts/auth';
import { accountsConfig } from '../src/accounts/config';
import { accountsEnv } from './accountsHarness';
import { SqliteD1 } from './sqliteD1';

const MIGRATION = readFileSync(new URL('../migrations/0008_accounts.sql', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
const installed = JSON.parse(readFileSync(new URL('../node_modules/better-auth/package.json', import.meta.url), 'utf8')) as { version: string };

/** Parte 1 de la migración (tablas de la biblioteca), sin comentarios. */
const libraryPart = () =>
  MIGRATION.split('-- Parte 2.')[0]!
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
const statements = (sql: string) =>
  sql
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

function optionsFor(db: SqliteD1) {
  const { env } = accountsEnv({ db });
  return authOptions(db, accountsConfig(env));
}

describe('versión de la biblioteca', () => {
  it('fijada exacta y coincidente con la instalada', () => {
    expect(pkg.dependencies['better-auth']).toBe('1.7.28');
    expect(installed.version).toBe('1.7.28');
  });
});

describe('esquema de la biblioteca en la migración 0008', () => {
  it('es exactamente el SQL que genera la biblioteca sobre la base hasta 0007', async () => {
    const db = new SqliteD1();
    db.migrate('0007_club_rankings.sql');
    const { compileMigrations, toBeCreated } = await getMigrations(optionsFor(db));
    expect(toBeCreated.map((t) => t.table).sort()).toEqual(['auth_account', 'auth_rate_limit', 'auth_session', 'auth_user', 'auth_verification']);
    expect(statements(libraryPart())).toEqual(statements(await compileMigrations()));
  });

  it('tras aplicar 0008, la biblioteca no detecta ninguna diferencia', async () => {
    const db = new SqliteD1();
    db.migrate();
    const { toBeCreated, toBeAdded, compileMigrations } = await getMigrations(optionsFor(db));
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
    expect(statements(await compileMigrations())).toEqual([]);
  });

  it('no existe ninguna tabla con los nombres por defecto de la biblioteca', () => {
    const db = new SqliteD1();
    db.migrate();
    const names = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['user', 'session', 'account', 'verification', 'rateLimit']) expect(names).not.toContain(t);
  });
});

describe('configuración explícita', () => {
  it('valores de seguridad fijados en el código', () => {
    const o = optionsFor(new SqliteD1());
    expect(o.basePath).toBe('/api/account/auth');
    expect(o.trustedOrigins).toEqual(['https://cuentas.galipau.test']);
    expect(o.telemetry).toEqual({ enabled: false });
    expect(o.emailAndPassword).toEqual({ enabled: false });
    expect(o.session).toMatchObject({ expiresIn: SESSION_SECONDS, updateAge: 86400, cookieCache: { enabled: false } });
    expect(SESSION_SECONDS).toBe(7 * 24 * 3600);
    expect(o.rateLimit).toMatchObject({ enabled: true, storage: 'database', modelName: 'auth_rate_limit' });
    expect(o.advanced).toMatchObject({
      useSecureCookies: true,
      disableOriginCheck: false,
      disableCSRFCheck: false,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { sameSite: 'strict', httpOnly: true, secure: true, path: AUTH_COOKIE_PATH },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    });
    const otp = o.plugins?.find((p) => p.id === 'email-otp') as { options?: Record<string, unknown> } | undefined;
    expect(otp?.options).toMatchObject({ otpLength: 6, expiresIn: 300, allowedAttempts: 3, storeOTP: 'hashed', disableSignUp: false });
    expect(o.plugins?.some((p) => p.id === 'captcha')).toBe(true);
  });
});
