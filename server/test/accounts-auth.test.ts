// Seguridad del inicio de sesión de las cuentas de club: códigos, sesiones, límites,
// Turnstile, origen y CSRF, cuentas desactivadas y separación respecto a los
// códigos de entrenador y consulta. Base local en memoria y datos sintéticos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountsEnv,
  call,
  cookieOf,
  count,
  getSession,
  login,
  one,
  ORIGIN,
  sendCode,
  signIn,
  stubTurnstile,
  type Ctx,
} from './accountsHarness';
import { addDevice, twoClubs } from './seed';

beforeEach(() => {
  stubTurnstile();
});
afterEach(() => vi.unstubAllGlobals());

const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('registro e inicio con código', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = accountsEnv({ publicSignup: true });
  });

  it('alta, correo verificado, cookie segura y sesión de 7 días', async () => {
    const s = await sendCode(ctx.env, 'Ana@Example.test');
    expect(s.status).toBe(200);
    const mail = ctx.mail.last('ana@example.test');
    expect(mail?.code).toMatch(/^\d{6}$/);
    expect(mail?.purpose).toBe('sign-in');
    // El código se guarda con hash.
    const stored = one<{ value: string }>(ctx.db, "SELECT value FROM auth_verification WHERE identifier = 'sign-in-otp-ana@example.test'");
    expect(stored.value).not.toContain(mail!.code);

    const r = await signIn(ctx.env, 'ana@example.test', mail!.code);
    expect(r.status).toBe(200);
    expect(r.data.user).toMatchObject({ email: 'ana@example.test', emailVerified: true });
    const raw = r.setCookie.find((c) => c.includes('session_token'))!;
    expect(raw.startsWith('__Secure-gs.session_token=')).toBe(true);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/;\s*Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\/(;|$)/);
    expect(raw).toMatch(/Max-Age=604800/);
    expect(raw).not.toMatch(/Domain=/i);
    const me = await call(ctx.env, '/api/account/me', { cookie: cookieOf(r) });
    expect(me.status).toBe(200);
    expect(me.data.user).toMatchObject({ email: 'ana@example.test' });
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_account WHERE password IS NOT NULL')).toBe(0);
  });

  it('verificación de correo con código', async () => {
    const a = await login(ctx, 'bea@example.test');
    // Las cuentas nacen verificadas (el código lo prueba); la ruta de verificación
    // acepta un código válido y rechaza uno erróneo.
    await sendCode(ctx.env, 'bea@example.test', { type: 'email-verification' });
    const m = ctx.mail.last('bea@example.test')!;
    expect(m.purpose).toBe('email-verification');
    const bad = await call(ctx.env, '/api/account/auth/email-otp/verify-email', { body: { email: 'bea@example.test', otp: wrong(m.code) } });
    expect(bad.status).toBe(400);
    const ok = await call(ctx.env, '/api/account/auth/email-otp/verify-email', { body: { email: 'bea@example.test', otp: m.code } });
    expect(ok.status).toBe(200);
    expect(one<{ v: number }>(ctx.db, "SELECT emailVerified AS v FROM auth_user WHERE email = 'bea@example.test'").v).toBe(1);
    expect(a).not.toBeNull();
  });

  it('código incorrecto, reutilizado, sustituido y caducado', async () => {
    await login(ctx, 'carla@example.test');
    await sendCode(ctx.env, 'carla@example.test');
    const c1 = ctx.mail.last('carla@example.test')!.code;
    expect((await signIn(ctx.env, 'carla@example.test', wrong(c1))).data.code).toBe('INVALID_OTP');
    expect((await signIn(ctx.env, 'carla@example.test', c1)).status).toBe(200);
    expect((await signIn(ctx.env, 'carla@example.test', c1)).data.code).toBe('INVALID_OTP'); // reutilizado

    await sendCode(ctx.env, 'carla@example.test');
    const old = ctx.mail.last('carla@example.test')!.code;
    await sendCode(ctx.env, 'carla@example.test');
    const fresh = ctx.mail.last('carla@example.test')!.code;
    if (old !== fresh) expect((await signIn(ctx.env, 'carla@example.test', old)).status).toBe(400); // sustituido
    expect((await signIn(ctx.env, 'carla@example.test', fresh)).status).toBe(200);

    await sendCode(ctx.env, 'carla@example.test');
    const exp = ctx.mail.last('carla@example.test')!.code;
    ctx.db.run("UPDATE auth_verification SET expiresAt = ? WHERE identifier = 'sign-in-otp-carla@example.test'", '2020-01-01T00:00:00.000Z');
    const e = await signIn(ctx.env, 'carla@example.test', exp);
    expect(e.status).toBe(400);
    expect(e.data.code).toBe('OTP_EXPIRED');
  });

  it('tres fallos bloquean el código, incluso el correcto', async () => {
    await sendCode(ctx.env, 'dani@example.test');
    const code = ctx.mail.last('dani@example.test')!.code;
    for (let i = 0; i < 3; i++) expect((await signIn(ctx.env, 'dani@example.test', wrong(code))).status).toBe(400);
    const r = await signIn(ctx.env, 'dani@example.test', code);
    expect(r.status).toBe(403);
    expect(r.data.code).toBe('TOO_MANY_ATTEMPTS');
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM auth_user WHERE email = 'dani@example.test'")).toBe(0);
  });
});

describe('sesiones', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = accountsEnv({ publicSignup: true });
  });

  it('cierre de sesión: la cookie antigua deja de valer', async () => {
    const a = (await login(ctx, 'eva@example.test'))!;
    const out = await call(ctx.env, '/api/account/auth/sign-out', { cookie: a.cookie, body: {} });
    expect(out.status).toBe(200);
    expect((await getSession(ctx.env, a.cookie)).raw).toBeNull();
    expect((await call(ctx.env, '/api/account/me', { cookie: a.cookie })).status).toBe(401);
  });

  it('sesión caducada: 401', async () => {
    const a = (await login(ctx, 'fer@example.test'))!;
    ctx.db.run('UPDATE auth_session SET expiresAt = ? WHERE "userId" = ?', '2020-01-01T00:00:00.000Z', a.id);
    expect((await call(ctx.env, '/api/account/me', { cookie: a.cookie })).status).toBe(401);
  });

  it('revocación de una, de las demás y de todas, con efecto inmediato', async () => {
    const a1 = (await login(ctx, 'gema@example.test'))!;
    const a2 = (await login(ctx, 'gema@example.test'))!;
    const a3 = (await login(ctx, 'gema@example.test'))!;
    const list = await call(ctx.env, '/api/account/auth/list-sessions', { cookie: a1.cookie });
    expect((list.raw as unknown[]).length).toBe(3);
    const token2 = decodeURIComponent(a2.cookie.split('=')[1]!).split('.')[0]!;
    expect((await call(ctx.env, '/api/account/auth/revoke-session', { cookie: a1.cookie, body: { token: token2 } })).status).toBe(200);
    expect((await call(ctx.env, '/api/account/me', { cookie: a2.cookie })).status).toBe(401);
    expect((await call(ctx.env, '/api/account/me', { cookie: a1.cookie })).status).toBe(200);
    expect((await call(ctx.env, '/api/account/auth/revoke-other-sessions', { cookie: a1.cookie, body: {} })).status).toBe(200);
    expect((await call(ctx.env, '/api/account/me', { cookie: a3.cookie })).status).toBe(401);
    expect((await call(ctx.env, '/api/account/auth/revoke-sessions', { cookie: a1.cookie, body: {} })).status).toBe(200);
    expect((await call(ctx.env, '/api/account/me', { cookie: a1.cookie })).status).toBe(401);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_session WHERE "userId" = ?', a1.id)).toBe(0);
  });

  it('una cuenta no revoca ni ve las sesiones de otra; un token sin firma no vale', async () => {
    const a = (await login(ctx, 'hugo@example.test'))!;
    const b = (await login(ctx, 'ines@example.test'))!;
    const tokenA = decodeURIComponent(a.cookie.split('=')[1]!).split('.')[0]!;
    await call(ctx.env, '/api/account/auth/revoke-session', { cookie: b.cookie, body: { token: tokenA } });
    expect((await call(ctx.env, '/api/account/me', { cookie: a.cookie })).status).toBe(200);
    const listB = (await call(ctx.env, '/api/account/auth/list-sessions', { cookie: b.cookie })).raw as { userId: string }[];
    expect(listB.every((s) => s.userId === b.id)).toBe(true);
    expect((await call(ctx.env, '/api/account/me', { cookie: `__Secure-gs.session_token=${tokenA}` })).status).toBe(401);
  });
});

describe('límites y Turnstile', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = accountsEnv({ publicSignup: true });
  });

  it('por IP: 3 solicitudes de código por minuto', async () => {
    const ip = '10.200.0.1';
    const st = [];
    for (let i = 0; i < 5; i++) st.push((await sendCode(ctx.env, `ip${i}@example.test`, { ip })).status);
    expect(st).toEqual([200, 200, 200, 429, 429]);
  });

  it('por correo: 5 por hora aunque cambie la IP', async () => {
    const st = [];
    for (let i = 0; i < 7; i++) st.push((await sendCode(ctx.env, 'limite@example.test')).status);
    expect(st).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(ctx.mail.count('limite@example.test')).toBe(5);
    // El correo no se guarda en claro en los contadores.
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM auth_attempts WHERE bucket LIKE '%limite%'")).toBe(0);
  });

  it('por correo, bajo solicitudes simultáneas: como mucho 5 correos', async () => {
    const res = await Promise.all(Array.from({ length: 12 }, () => sendCode(ctx.env, 'rafaga@example.test')));
    expect(res.filter((r) => r.status === 200).length).toBe(5);
    expect(ctx.mail.count('rafaga@example.test')).toBe(5);
  });

  it('Turnstile obligatorio al pedir código, entrar y verificar', async () => {
    const none = await sendCode(ctx.env, 'jon@example.test', { turnstile: null });
    expect(none.status).toBe(400);
    const bad = await sendCode(ctx.env, 'jon@example.test', { turnstile: 'falso' });
    expect(bad.status).toBe(403);
    expect(ctx.mail.count('jon@example.test')).toBe(0);
    await sendCode(ctx.env, 'jon@example.test');
    const code = ctx.mail.last('jon@example.test')!.code;
    expect((await signIn(ctx.env, 'jon@example.test', code, { turnstile: null })).status).toBe(400);
    expect((await call(ctx.env, '/api/account/auth/email-otp/verify-email', { body: { email: 'jon@example.test', otp: code }, turnstile: null })).status).toBe(400);
    expect((await signIn(ctx.env, 'jon@example.test', code)).status).toBe(200);
  });
});

describe('solicitudes simultáneas', () => {
  it('diez entradas a la vez con el mismo código: una cuenta y una sesión', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    await sendCode(ctx.env, 'kira@example.test');
    const code = ctx.mail.last('kira@example.test')!.code;
    const res = await Promise.all(Array.from({ length: 10 }, () => signIn(ctx.env, 'kira@example.test', code)));
    expect(res.filter((r) => r.status === 200).length).toBe(1);
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM auth_user WHERE email = 'kira@example.test'")).toBe(1);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_session')).toBe(1);
  });

  it('peticiones de código simultáneas: un solo código válido', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    await Promise.all(Array.from({ length: 4 }, () => sendCode(ctx.env, 'leo@example.test')));
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM auth_verification WHERE identifier = 'sign-in-otp-leo@example.test'")).toBe(1);
  });
});

describe('origen y CSRF', () => {
  it('origen ajeno, ausente o sin JSON: rechazado', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const a = (await login(ctx, 'mar@example.test'))!;
    expect((await call(ctx.env, '/api/account/auth/sign-out', { cookie: a.cookie, body: {}, origin: 'https://atacante.example' })).status).toBe(403);
    expect((await call(ctx.env, '/api/account/auth/sign-out', { cookie: a.cookie, body: {}, origin: null })).status).toBe(403);
    expect((await call(ctx.env, '/api/account/deactivate', { cookie: a.cookie, body: {}, origin: 'https://atacante.example' })).status).toBe(403);
    expect((await call(ctx.env, '/api/account/deactivate', { cookie: a.cookie, body: 'x=1', contentType: 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await sendCode(ctx.env, 'mar@example.test', { origin: 'https://atacante.example' })).status).toBe(403);
    expect((await call(ctx.env, '/api/account/me', { cookie: a.cookie })).status).toBe(200);
  });

  it('las cuentas solo existen en su origen', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const r = await call(ctx.env, '/api/account/me', { host: 'https://otro-host.example' });
    expect(r.status).toBe(404);
  });

  it('las respuestas no se guardan en caché y no llevan CORS', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const r = await sendCode(ctx.env, 'nora@example.test');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('registro cerrado y cuentas desactivadas', () => {
  it('sin registro libre ni invitación: no se envía código ni se crea cuenta', async () => {
    const ctx = accountsEnv({ publicSignup: false });
    const s = await sendCode(ctx.env, 'nadie@example.test');
    expect(s.status).toBe(200);
    expect(s.data).toEqual({ success: true });
    expect(ctx.mail.count('nadie@example.test')).toBe(0);
    const r = await signIn(ctx.env, 'nadie@example.test', '123456');
    expect(r.status).toBe(400);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_user')).toBe(0);
  });

  it('sin registro libre, aunque alguien salte el filtro previo, la biblioteca no crea la cuenta', async () => {
    const ctx = accountsEnv({ publicSignup: false });
    // Se simula un código emitido (p. ej. una invitación revocada después de pedirlo).
    ctx.db.run("INSERT INTO clubs (id, name, created_at, updated_at) VALUES ('c', 'C', '2026-01-01', '2026-01-01')");
    ctx.db.run(
      "INSERT INTO club_invitations (id, club_id, email, role, created_at, expires_at) VALUES ('i', 'c', 'ola@example.test', 'admin', '2026-01-01', '2999-01-01T00:00:00.000Z')",
    );
    await sendCode(ctx.env, 'ola@example.test');
    const code = ctx.mail.last('ola@example.test')!.code;
    ctx.db.run("UPDATE club_invitations SET revoked_at = '2026-01-02' WHERE id = 'i'");
    const r = await signIn(ctx.env, 'ola@example.test', code);
    expect(r.status).toBe(400);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_user')).toBe(0);
  });

  it('cuenta desactivada: sin código, sin entrada y sin sesiones', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const a = (await login(ctx, 'pau@example.test'))!;
    const d = await call(ctx.env, '/api/account/deactivate', { cookie: a.cookie, body: {} });
    expect(d.status).toBe(200);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_session WHERE "userId" = ?', a.id)).toBe(0);
    expect((await call(ctx.env, '/api/account/me', { cookie: a.cookie })).status).toBe(401);
    const before = ctx.mail.count('pau@example.test');
    const s = await sendCode(ctx.env, 'pau@example.test');
    expect(s.data).toEqual({ success: true }); // misma respuesta que sin cuenta
    expect(ctx.mail.count('pau@example.test')).toBe(before);
    // Ni con un código emitido antes de desactivarla.
    ctx.db.run("DELETE FROM account_state WHERE user_id = ?", a.id);
    await sendCode(ctx.env, 'pau@example.test');
    const code = ctx.mail.last('pau@example.test')!.code;
    ctx.db.run("INSERT INTO account_state (user_id, status, disabled_at, disabled_reason, updated_at) VALUES (?, 'disabled', '2026-01-01', 'superadmin', '2026-01-01')", a.id);
    const r = await signIn(ctx.env, 'pau@example.test', code);
    expect(r.status).toBe(400);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_session WHERE "userId" = ?', a.id)).toBe(0);
  });

  it('si una sesión sobrevive a la desactivación, se rechaza igualmente', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const a = (await login(ctx, 'quim@example.test'))!;
    ctx.db.run("INSERT INTO account_state (user_id, status, disabled_at, disabled_reason, updated_at) VALUES (?, 'disabled', '2026-01-01', 'superadmin', '2026-01-01')", a.id);
    expect((await call(ctx.env, '/api/account/me', { cookie: a.cookie })).status).toBe(401);
  });
});

describe('códigos de entrenador y consulta', () => {
  it('un token de dispositivo no da acceso a las cuentas, y una sesión de cuenta no sirve para dispositivos ni administración', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    twoClubs(ctx.db);
    const coach = await addDevice(ctx.db, 'dev-coach', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    const viewer = await addDevice(ctx.db, 'dev-viewer', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }]);
    for (const token of [coach.token, viewer.token]) {
      expect((await call(ctx.env, '/api/account/me', { token })).status).toBe(401);
      expect((await call(ctx.env, '/api/account/clubs', { token, body: { id: crypto.randomUUID(), name: 'X' } })).status).toBe(401);
      expect((await call(ctx.env, '/api/account/clubs/A', { token })).status).toBe(401);
    }
    const a = (await login(ctx, 'rita@example.test'))!;
    // La cookie es solo para /api/account; aunque se envíe, la API de dispositivos no la usa.
    expect((await call(ctx.env, '/api/session', { cookie: a.cookie })).status).toBe(401);
    expect((await call(ctx.env, '/api/teams/a1', { cookie: a.cookie })).status).toBe(401);
    const adm = await call(ctx.env, '/api/admin/me', { cookie: a.cookie });
    expect([401, 403, 503]).toContain(adm.status);
    // Y el dispositivo sigue funcionando como siempre con las cuentas activadas.
    expect((await call(ctx.env, '/api/session', { token: coach.token, host: ORIGIN })).status).toBe(200);
  });
});
