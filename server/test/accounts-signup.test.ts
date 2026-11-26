// Registro: con ACCOUNTS_PUBLIC_SIGNUP desactivado nadie crea cuentas por su cuenta;
// con el registro libre habilitado, una persona crea su cuenta, verifica su correo y
// se convierte en propietaria de su club sin ninguna intervención de la
// superadministración.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsEnv, call, cookieOf, count, login, sendCode, signIn, stubTurnstile } from './accountsHarness';

beforeEach(() => {
  stubTurnstile();
});
afterEach(() => vi.unstubAllGlobals());

describe('registro público desactivado', () => {
  it('no se pueden crear cuentas arbitrarias por ninguna vía', async () => {
    const ctx = accountsEnv({ publicSignup: false });
    const emails = ['uno@example.test', 'dos@example.test', 'Tres@Example.test'];
    for (const email of emails) {
      expect((await sendCode(ctx.env, email)).data).toEqual({ success: true });
      expect((await sendCode(ctx.env, email, { type: 'email-verification' })).data).toEqual({ success: true });
      // Códigos inventados, por las tres rutas de código.
      for (const otp of ['000000', '123456', '999999']) {
        expect((await signIn(ctx.env, email, otp)).status).toBe(400);
        expect((await call(ctx.env, '/api/account/auth/email-otp/verify-email', { body: { email, otp } })).status).toBe(400);
      }
    }
    expect(ctx.mail.sent).toEqual([]);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_user')).toBe(0);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_session')).toBe(0);
    // Ni rutas de la biblioteca que no se usan.
    expect((await call(ctx.env, '/api/account/auth/sign-up/email', { body: { email: 'x@example.test', password: 'clave-larga-123', name: 'X' } })).status).not.toBe(200);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_user')).toBe(0);
  });

  it('una cuenta existente puede entrar, pero no crear clubes', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const a = (await login(ctx, 'ana@example.test'))!;
    ctx.env.ACCOUNTS_PUBLIC_SIGNUP = 'false';
    expect(await login(ctx, 'ana@example.test')).not.toBeNull();
    const r = await call(ctx.env, '/api/account/clubs', { cookie: a.cookie, body: { id: crypto.randomUUID(), name: 'X' } });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe('signup_closed');
    expect(await login(ctx, 'nueva@example.test')).toBeNull();
  });

  it('el registro público sin la infraestructura activada no existe', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    ctx.env.ACCOUNTS_ENABLED = 'false';
    expect((await sendCode(ctx.env, 'ana@example.test')).status).toBe(401); // camino de dispositivos de siempre
    expect(ctx.mail.sent).toEqual([]);
  });
});

describe('registro público habilitado (pruebas locales)', () => {
  it('cuenta, correo verificado y club propio sin intervención de la superadministración', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const adminRows = () =>
      count(ctx.db, 'SELECT (SELECT COUNT(*) FROM admin_identities) + (SELECT COUNT(*) FROM admin_roles) + (SELECT COUNT(*) FROM admin_audit) AS n');
    const before = adminRows();

    // 1. Pide un código y entra: se crea su cuenta.
    expect((await sendCode(ctx.env, 'Lucia@Example.test')).status).toBe(200);
    const mail = ctx.mail.last('lucia@example.test')!;
    expect(mail.purpose).toBe('sign-in');
    const s = await signIn(ctx.env, 'lucia@example.test', mail.code);
    expect(s.status).toBe(200);
    const cookie = cookieOf(s);

    // 2. Su correo queda verificado (el código lo prueba); también lo confirma la verificación explícita.
    expect((s.data.user as { emailVerified: boolean }).emailVerified).toBe(true);
    await sendCode(ctx.env, 'lucia@example.test', { type: 'email-verification' });
    const v = await call(ctx.env, '/api/account/auth/email-otp/verify-email', { body: { email: 'lucia@example.test', otp: ctx.mail.last('lucia@example.test')!.code } });
    expect(v.status).toBe(200);

    // 3. Crea su club y 4. es su propietaria.
    const id = crypto.randomUUID();
    const c = await call(ctx.env, '/api/account/clubs', { cookie, body: { id, name: 'CB Autónomo' } });
    expect(c.status).toBe(201);
    expect((await call(ctx.env, `/api/club/${id}/me`, { cookie })).data.role).toBe('owner');
    expect((await call(ctx.env, '/api/account/me', { cookie })).data.clubs).toEqual([{ id, name: 'CB Autónomo', role: 'owner' }]);

    // 5. Sin aprobación ni intervención de la superadministración.
    expect(adminRows()).toBe(before);
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM account_audit WHERE action = 'club.create' AND actor_user_id IS NOT NULL")).toBe(1);

    // Y ya puede invitar a sus administradores.
    expect((await call(ctx.env, `/api/club/${id}/me`, { cookie })).status).toBe(200);
    expect((await call(ctx.env, `/api/account/clubs/${id}/invitations`, { cookie, body: { email: 'pablo@example.test' } })).status).toBe(201);
  });
});
