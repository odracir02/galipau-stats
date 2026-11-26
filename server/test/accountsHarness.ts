// Utilidades comunes de las pruebas de cuentas de club: entorno con base local en
// memoria, correo simulado, Turnstile simulado y un cliente HTTP con cookies.
// Solo datos sintéticos.
import { vi } from 'vitest';
import worker, { type Env } from '../src/index';
import type { AccountMailer, CodePurpose } from '../src/accounts/mail';
import { PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

export const ORIGIN = 'https://cuentas.galipau.test';
export const APP = 'https://develop.galipau-stats.pages.dev';
export const TURNSTILE_OK = 'turnstile-valido';
const SECRET = 'secreto-de-firma-de-pruebas-0123456789-abcdef';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Correo simulado: guarda los mensajes en memoria. */
export class CapturedMailer implements AccountMailer {
  readonly sent: { to: string; code: string; purpose: CodePurpose }[] = [];
  async sendCode(message: { to: string; code: string; purpose: CodePurpose }): Promise<void> {
    this.sent.push(message);
  }
  last(to: string) {
    return [...this.sent].reverse().find((m) => m.to === to) ?? null;
  }
  count(to: string) {
    return this.sent.filter((m) => m.to === to).length;
  }
}

/** Turnstile simulado: solo acepta TURNSTILE_OK. El resto de fetch no se usa. */
export function stubTurnstile() {
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== SITEVERIFY) throw new Error(`fetch inesperado en pruebas: ${url}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as { response?: string };
    calls.push(body);
    return new Response(JSON.stringify(body.response === TURNSTILE_OK ? { success: true, hostname: 'cuentas.galipau.test' } : { success: false, 'error-codes': ['invalid-input-response'] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

export interface Ctx {
  db: SqliteD1;
  env: Env;
  mail: CapturedMailer;
}

export function accountsEnv(opts: { publicSignup?: boolean; db?: SqliteD1; overrides?: Partial<Env> } = {}): Ctx {
  const db = opts.db ?? migratedDb();
  const mail = new CapturedMailer();
  const env: Env = {
    DB: db,
    TOKEN_PEPPER: PEPPER,
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: APP,
    ACCOUNTS_ENABLED: 'true',
    ACCOUNTS_PUBLIC_SIGNUP: opts.publicSignup ? 'true' : 'false',
    ACCOUNTS_ORIGIN: ORIGIN,
    BETTER_AUTH_SECRET: SECRET,
    TURNSTILE_SECRET_KEY: 'clave-turnstile-de-pruebas',
    ACCOUNTS_MAILER: mail,
    ...opts.overrides,
  };
  return { db, env, mail };
}

let ipSeq = 0;
export const freshIp = () => {
  ipSeq++;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};

export interface CallOpts {
  method?: string;
  body?: unknown;
  cookie?: string | null;
  origin?: string | null;
  turnstile?: string | null;
  ip?: string;
  token?: string;
  host?: string;
  contentType?: string | null;
}

export interface Res {
  status: number;
  data: Record<string, unknown> & { code?: string; error?: string };
  raw: unknown;
  setCookie: string[];
  headers: Headers;
}

export async function call(env: Env, path: string, o: CallOpts = {}): Promise<Res> {
  const method = o.method ?? (o.body !== undefined ? 'POST' : 'GET');
  const headers = new Headers({ 'cf-connecting-ip': o.ip ?? freshIp() });
  if (o.body !== undefined && o.contentType !== null) headers.set('content-type', o.contentType ?? 'application/json');
  if (o.cookie) headers.set('cookie', o.cookie);
  const origin = o.origin === undefined ? (method === 'GET' ? null : ORIGIN) : o.origin;
  if (origin) headers.set('origin', origin);
  const turnstile = o.turnstile === undefined ? TURNSTILE_OK : o.turnstile;
  if (turnstile) headers.set('x-captcha-response', turnstile);
  if (o.token) headers.set('authorization', `Bearer ${o.token}`);
  const res = await worker.fetch(
    new Request(`${o.host ?? ORIGIN}${path}`, { method, headers, body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body) }),
    env,
  );
  const text = await res.text();
  let raw: unknown = text;
  try {
    raw = JSON.parse(text);
  } catch {
    /* no es JSON */
  }
  const data = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Res['data'];
  return { status: res.status, data, raw, setCookie: res.headers.getSetCookie(), headers: res.headers };
}

export const cookieOf = (r: Res) =>
  r.setCookie
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='))
    .join('; ');

export const sendCode = (env: Env, email: string, o: CallOpts & { type?: string } = {}) =>
  call(env, '/api/account/auth/email-otp/send-verification-otp', { body: { email, type: o.type ?? 'sign-in' }, ...o });
export const signIn = (env: Env, email: string, otp: string, o: CallOpts = {}) => call(env, '/api/account/auth/sign-in/email-otp', { body: { email, otp }, ...o });
export const getSession = (env: Env, cookie: string | null) => call(env, '/api/account/auth/get-session', { cookie });

/** Pide código y entra. Devuelve la cookie y el id de la cuenta (o null si no hubo código). */
export async function login(ctx: Ctx, email: string): Promise<{ cookie: string; id: string; res: Res } | null> {
  const before = ctx.mail.count(email);
  await sendCode(ctx.env, email);
  if (ctx.mail.count(email) === before) return null;
  const res = await signIn(ctx.env, email, ctx.mail.last(email)!.code);
  if (res.status !== 200) return null;
  return { cookie: cookieOf(res), id: (res.data.user as { id: string }).id, res };
}

export const one = <T = Record<string, unknown>>(db: SqliteD1, sql: string, ...v: (string | number)[]) => db.sqlite.prepare(sql).get(...v) as T;
export const count = (db: SqliteD1, sql: string, ...v: (string | number)[]) => (one<{ n: number }>(db, sql, ...v)).n;
