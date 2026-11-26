// Cookie de sesión de las cuentas (Path=/, solo el host): sirve en las rutas de
// cuentas y en las administrativas del club del mismo origen, no se comparte con
// otro host y no concede nada por sí misma.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsEnv, call, count, login, stubTurnstile, type Ctx } from './accountsHarness';
import { addDevice, twoClubs } from './seed';

beforeEach(() => {
  stubTurnstile();
});
afterEach(() => vi.unstubAllGlobals());

const DEVICE_HOST = 'https://api.galipau.test';
type Who = { cookie: string; id: string };

async function setup() {
  const ctx = accountsEnv({ publicSignup: true });
  twoClubs(ctx.db);
  const owner = (await login(ctx, 'propietaria@example.test'))!;
  const club = ((await call(ctx.env, '/api/account/clubs', { cookie: owner.cookie, body: { id: crypto.randomUUID(), name: 'Club propio' } })).data.club as { id: string }).id;
  const admin = (await login(ctx, 'admin@example.test'))!;
  const inv = (await call(ctx.env, `/api/account/clubs/${club}/invitations`, { cookie: owner.cookie, body: { email: 'admin@example.test' } })).data.invitation as { id: string };
  await call(ctx.env, `/api/account/invitations/${inv.id}/accept`, { cookie: admin.cookie, body: {} });
  const stranger = (await login(ctx, 'ajena@example.test'))!;
  return { ctx, owner, admin, stranger, club };
}
const clubMe = (ctx: Ctx, who: Who | null, clubId: string, o: { host?: string; token?: string } = {}) =>
  call(ctx.env, `/api/club/${clubId}/me`, { cookie: who?.cookie ?? null, ...o });

describe('atributos de la cookie', () => {
  it('Path=/, sin Domain (solo el host), HttpOnly, Secure, SameSite=Strict y prefijo __Secure-', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const a = (await login(ctx, 'ana@example.test'))!;
    const raw = a.res.setCookie.find((c) => c.includes('session_token'))!;
    const attrs = raw.split(';').map((s) => s.trim());
    expect(attrs[0]!.startsWith('__Secure-gs.session_token=')).toBe(true);
    expect(attrs).toContain('Path=/');
    expect(attrs.some((x) => /^Domain=/i.test(x))).toBe(false);
    expect(attrs).toContain('HttpOnly');
    expect(attrs).toContain('Secure');
    expect(attrs).toContain('SameSite=Strict');
    // Al cerrar sesión se borra con los mismos atributos.
    const out = await call(ctx.env, '/api/account/auth/sign-out', { cookie: a.cookie, body: {} });
    const cleared = out.setCookie.find((c) => c.startsWith('__Secure-gs.session_token='))!;
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/Path=\/(;|$)/);
  });
});

describe('la sesión en las rutas del mismo origen', () => {
  it('funciona en /api/account/* y en la ruta administrativa protegida del club', async () => {
    const { ctx, owner, admin, club } = await setup();
    expect((await call(ctx.env, '/api/account/me', { cookie: owner.cookie })).status).toBe(200);
    const o = await clubMe(ctx, owner, club);
    expect(o.status).toBe(200);
    expect(o.data).toEqual({ clubId: club, role: 'owner', clubStatus: 'active' });
    expect((await clubMe(ctx, admin, club)).data.role).toBe('admin');
  });

  it('recibir la cookie no concede nada: sin rol en el club, 404; club inexistente o existente sin propietario, 404', async () => {
    const { ctx, stranger, owner, club } = await setup();
    expect((await clubMe(ctx, stranger, club)).status).toBe(404);
    expect((await clubMe(ctx, owner, crypto.randomUUID())).status).toBe(404);
    expect((await clubMe(ctx, owner, 'A')).status).toBe(404); // club existente gestionado por la administración
    expect((await clubMe(ctx, null, club)).status).toBe(401);
    expect((await call(ctx.env, `/api/club/${club}/otra`, { cookie: owner.cookie })).status).toBe(404);
  });

  it('las escrituras exigen origen propio también en /api/club', async () => {
    const { ctx, owner, club } = await setup();
    expect((await call(ctx.env, `/api/club/${club}/me`, { cookie: owner.cookie, body: {}, origin: 'https://atacante.example' })).status).toBe(403);
    expect((await call(ctx.env, `/api/club/${club}/me`, { cookie: owner.cookie, body: {}, origin: null })).status).toBe(403);
  });

  it('una sesión revocada deja de funcionar al instante en todas las rutas', async () => {
    const { ctx, owner, club } = await setup();
    const other = (await login(ctx, 'propietaria@example.test'))!;
    const token = decodeURIComponent(other.cookie.split('=')[1]!).split('.')[0]!;
    await call(ctx.env, '/api/account/auth/revoke-session', { cookie: owner.cookie, body: { token } });
    expect((await clubMe(ctx, other, club)).status).toBe(401);
    expect((await call(ctx.env, '/api/account/me', { cookie: other.cookie })).status).toBe(401);
    expect((await clubMe(ctx, owner, club)).status).toBe(200);
    await call(ctx.env, '/api/account/auth/revoke-sessions', { cookie: owner.cookie, body: {} });
    expect((await clubMe(ctx, owner, club)).status).toBe(401);
  });

  it('una cuenta desactivada no accede a operaciones administrativas', async () => {
    const { ctx, admin, club } = await setup();
    const extra = (await login(ctx, 'admin@example.test'))!;
    expect((await call(ctx.env, '/api/account/deactivate', { cookie: admin.cookie, body: {} })).status).toBe(200);
    for (const who of [admin, extra]) {
      expect((await clubMe(ctx, who, club)).status).toBe(401);
      expect((await call(ctx.env, `/api/account/clubs/${club}`, { cookie: who.cookie })).status).toBe(401);
    }
    // Aunque quedara una sesión (desactivación directa en la base), se rechaza.
    const { ctx: ctx2, admin: admin2, club: club2 } = await setup();
    ctx2.db.run("INSERT INTO account_state (user_id, status, disabled_at, disabled_reason, updated_at) VALUES (?, 'disabled', 'x', 'superadmin', 'x')", admin2.id);
    expect(count(ctx2.db, 'SELECT COUNT(*) AS n FROM auth_session WHERE "userId" = ?', admin2.id)).toBeGreaterThan(0);
    expect((await clubMe(ctx2, admin2, club2)).status).toBe(401);
  });
});

describe('separación de la API de dispositivos', () => {
  it('en otro host las rutas de cuentas y de club no existen, aunque llegue la cookie', async () => {
    const { ctx, owner, club } = await setup();
    // Sin Domain, el navegador no envía la cookie a otro host; aunque llegara, no sirve.
    expect((await clubMe(ctx, owner, club, { host: DEVICE_HOST })).status).toBe(404);
    expect((await call(ctx.env, '/api/account/me', { cookie: owner.cookie, host: DEVICE_HOST })).status).toBe(404);
  });

  it('en el mismo host, la API de dispositivos ignora la cookie y solo atiende al token', async () => {
    const { ctx, owner } = await setup();
    expect((await call(ctx.env, '/api/session', { cookie: owner.cookie })).status).toBe(401);
    expect((await call(ctx.env, '/api/teams/a1', { cookie: owner.cookie })).status).toBe(401);
    const viewer = await addDevice(ctx.db, 'dev-v', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }]);
    const s = await call(ctx.env, '/api/session', { cookie: owner.cookie, token: viewer.token });
    expect(s.status).toBe(200);
    // El dispositivo sigue siendo solo de consulta: la cookie no le añade permisos.
    const write = await call(ctx.env, '/api/sync/players', { cookie: owner.cookie, token: viewer.token, body: {}, origin: null });
    expect([400, 403, 404]).toContain(write.status);
    expect(write.status).not.toBe(200);
    const adm = await call(ctx.env, '/api/admin/me', { cookie: owner.cookie });
    expect(adm.status).not.toBe(200);
  });

  it('un código de entrenador o de consulta no da acceso a las rutas administrativas del club', async () => {
    const { ctx, club } = await setup();
    const coach = await addDevice(ctx.db, 'dev-c', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    const viewer = await addDevice(ctx.db, 'dev-v2', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }]);
    for (const token of [coach.token, viewer.token]) {
      for (const clubId of [club, 'A']) expect((await clubMe(ctx, null, clubId, { token })).status).toBe(401);
    }
  });
});
