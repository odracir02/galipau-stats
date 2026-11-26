// Lo que necesita el panel de clubes: configuración pública, archivos del panel en
// /club/ (solo con las cuentas activadas y en su origen), nombre corto del club y
// resumen de equipos con autorización de club. Base local y datos sintéticos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index';
import { accountsEnv, APP, call, count, login, one, ORIGIN, stubTurnstile, type Ctx } from './accountsHarness';
import { MAX_PENDING_INVITATIONS } from '../src/accounts/clubs';
import { addTeam, NOW, twoClubs } from './seed';

beforeEach(() => {
  stubTurnstile();
});
afterEach(() => vi.unstubAllGlobals());

/** Archivos del panel simulados (lo que sirve el binding ASSETS en Cloudflare). */
const assets = {
  fetch: async (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === '/club/' || path === '/club/index.html') return new Response('<!doctype html><title>Clubes</title>', { headers: { 'content-type': 'text/html' } });
    if (path === '/club/assets/app.js') return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
    return new Response('no encontrado', { status: 404 });
  },
};

const withAssets = (ctx: Ctx): Env => ({ ...ctx.env, ASSETS: assets });
const uuid = () => crypto.randomUUID();

describe('configuración pública del panel', () => {
  it('sin sesión: alta abierta o no, clave de sitio y enlace a la PWA; nada más', async () => {
    const ctx = accountsEnv({ publicSignup: false });
    const r = await call(ctx.env, '/api/account/config');
    expect(r.status).toBe(200);
    expect(r.raw).toEqual({ publicSignup: false, turnstileSiteKey: 'clave-de-sitio-de-pruebas', appUrl: `${APP}/` });
    ctx.env.ACCOUNTS_PUBLIC_SIGNUP = 'true';
    expect((await call(ctx.env, '/api/account/config')).data.publicSignup).toBe(true);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('sin Turnstile (solo local y pruebas) no anuncia clave de sitio', async () => {
    const ctx = accountsEnv({ overrides: { TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined } });
    expect((await call(ctx.env, '/api/account/config')).data.turnstileSiteKey).toBeNull();
  });
});

describe('archivos del panel en /club/', () => {
  it('se sirven en el origen de cuentas con su política de seguridad', async () => {
    const ctx = accountsEnv();
    const r = await call(withAssets(ctx), '/club/');
    expect(r.status).toBe(200);
    expect(r.raw).toContain('<title>Clubes</title>');
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Con Turnstile configurado, su script y su marco (y nada más de fuera).
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect((await call(withAssets(ctx), '/club/assets/app.js')).status).toBe(200);
  });

  it('sin Turnstile la política no admite nada de fuera', async () => {
    const ctx = accountsEnv({ overrides: { TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined } });
    const csp = (await call(withAssets(ctx), '/club/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain('challenges.cloudflare.com');
  });

  it('en otro host, con otro método o con las cuentas apagadas no existe', async () => {
    const ctx = accountsEnv();
    expect((await call(withAssets(ctx), '/club/', { host: 'https://api.galipau.test' })).status).toBe(404);
    expect((await call(withAssets(ctx), '/club/', { method: 'POST', body: {} })).status).toBe(405);
    for (const value of ['false', undefined, 'TRUE']) {
      const off = { ...withAssets(ctx), ACCOUNTS_ENABLED: value };
      const r = await call(off, '/club/');
      expect(r.status).toBe(404);
      expect(r.raw).toEqual({ error: 'not_found', message: 'No encontrado.' });
      expect((await call(off, '/club/assets/app.js')).status).toBe(404);
    }
  });
});

describe('nombre corto del club', () => {
  it('se guarda, se devuelve y se valida', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const a = (await login(ctx, 'ana@example.test'))!;
    const id = uuid();
    const r = await call(ctx.env, '/api/account/clubs', { cookie: a.cookie, body: { id, name: 'Club Balonmano Sintético', shortName: '  CB Sintético ' } });
    expect(r.status).toBe(201);
    expect(r.data.club).toEqual({ id, name: 'Club Balonmano Sintético', shortName: 'CB Sintético' });
    expect((await call(ctx.env, '/api/account/me', { cookie: a.cookie })).data.clubs).toEqual([{ id, name: 'Club Balonmano Sintético', shortName: 'CB Sintético', role: 'owner' }]);
    expect(((await call(ctx.env, `/api/account/clubs/${id}`, { cookie: a.cookie })).data.club as { shortName: string }).shortName).toBe('CB Sintético');
    // Reintento: mismo club, mismo nombre corto.
    expect((await call(ctx.env, '/api/account/clubs', { cookie: a.cookie, body: { id, name: 'Club Balonmano Sintético', shortName: 'CB Sintético' } })).data).toMatchObject({ created: false, club: { shortName: 'CB Sintético' } });
    // Vacío = sin nombre corto; demasiado largo o de otro tipo = 400.
    const id2 = uuid();
    expect((await call(ctx.env, '/api/account/clubs', { cookie: a.cookie, body: { id: id2, name: 'Otro', shortName: '   ' } })).data.club).toMatchObject({ shortName: null });
    expect((await call(ctx.env, '/api/account/clubs', { cookie: a.cookie, body: { id: uuid(), name: 'X', shortName: 'x'.repeat(25) } })).status).toBe(400);
    expect((await call(ctx.env, '/api/account/clubs', { cookie: a.cookie, body: { id: uuid(), name: 'X', shortName: 5 } })).status).toBe(400);
  });
});

describe('resumen de equipos del club', () => {
  it('solo con rol en el club, sin equipos borrados y sin códigos de invitación', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    twoClubs(ctx.db);
    const ana = (await login(ctx, 'ana@example.test'))!;
    const bea = (await login(ctx, 'bea@example.test'))!;
    const club = ((await call(ctx.env, '/api/account/clubs', { cookie: ana.cookie, body: { id: uuid(), name: 'Club de Ana' } })).data.club as { id: string }).id;
    const empty = await call(ctx.env, `/api/club/${club}/teams`, { cookie: ana.cookie });
    expect(empty.status).toBe(200);
    expect(empty.data.teams).toEqual([]);

    addTeam(ctx.db, 'ta1', club, 'SMA2627');
    addTeam(ctx.db, 'ta2', club, 'JFA2526');
    ctx.db.run("UPDATE teams SET season = '2025/26' WHERE id = 'ta2'");
    addTeam(ctx.db, 'ta3', club, 'BORRADO');
    ctx.db.run('UPDATE teams SET deleted_at = ? WHERE id = ?', NOW, 'ta3');
    const r = await call(ctx.env, `/api/club/${club}/teams`, { cookie: ana.cookie });
    const teams = r.data.teams as { id: string; code: string; season: string }[];
    expect(teams.map((t) => t.id)).toEqual(['ta1', 'ta2']);
    expect(Object.keys(teams[0]!).sort()).toEqual(['category', 'code', 'gender', 'id', 'name', 'season']);
    expect(JSON.stringify(r.raw)).not.toMatch(/code_hash|code_enc|invite/i);

    // Otra cuenta, un club ajeno o uno gestionado por la administración: 404.
    expect((await call(ctx.env, `/api/club/${club}/teams`, { cookie: bea.cookie })).status).toBe(404);
    expect((await call(ctx.env, '/api/club/A/teams', { cookie: ana.cookie })).status).toBe(404);
    expect((await call(ctx.env, `/api/club/${club}/teams`)).status).toBe(401);
    expect((await call(ctx.env, `/api/club/${club}/teams`, { cookie: ana.cookie, host: 'https://api.galipau.test' })).status).toBe(404);
  });

  it('un administrador del club también lo ve; al retirarlo deja de verlo', async () => {
    const ctx = accountsEnv({ publicSignup: true });
    const ana = (await login(ctx, 'ana@example.test'))!;
    const club = ((await call(ctx.env, '/api/account/clubs', { cookie: ana.cookie, body: { id: uuid(), name: 'Club de Ana' } })).data.club as { id: string }).id;
    const inv = (await call(ctx.env, `/api/account/clubs/${club}/invitations`, { cookie: ana.cookie, body: { email: 'bea@example.test' } })).data.invitation as { id: string };
    const bea = (await login(ctx, 'bea@example.test'))!;
    await call(ctx.env, `/api/account/invitations/${inv.id}/accept`, { cookie: bea.cookie, body: {} });
    expect((await call(ctx.env, `/api/club/${club}/teams`, { cookie: bea.cookie })).status).toBe(200);
    await call(ctx.env, `/api/account/clubs/${club}/admins/${bea.id}/revoke`, { cookie: ana.cookie, body: {} });
    expect((await call(ctx.env, `/api/club/${club}/teams`, { cookie: bea.cookie })).status).toBe(404);
    expect(ORIGIN).toMatch(/^https:/);
  });
});

describe('gestión de administradores desde el panel', () => {
  type Who = { cookie: string; id: string };
  const post = (ctx: Ctx, who: Who | null, path: string, body: unknown = {}, origin?: string | null) =>
    call(ctx.env, path, { cookie: who?.cookie ?? null, body, origin });
  const get = (ctx: Ctx, who: Who, path: string) => call(ctx.env, path, { cookie: who.cookie });
  const pending = (ctx: Ctx, club: string) =>
    count(ctx.db, 'SELECT COUNT(*) AS n FROM club_invitations WHERE club_id = ? AND accepted_at IS NULL AND revoked_at IS NULL', club);
  const owners = (ctx: Ctx, club: string) => count(ctx.db, 'SELECT COUNT(*) AS n FROM club_owners WHERE club_id = ?', club);
  const ownerOf = (ctx: Ctx, club: string) => one<{ u: string } | undefined>(ctx.db, 'SELECT user_id AS u FROM club_owners WHERE club_id = ?', club)?.u ?? null;
  const isAdminIn = (ctx: Ctx, club: string, userId: string) =>
    count(ctx.db, 'SELECT COUNT(*) AS n FROM club_memberships WHERE club_id = ? AND user_id = ? AND revoked_at IS NULL', club, userId) === 1;

  /** Ana, propietaria de un club con Bea de administradora; Carla, propietaria de otro. */
  async function scene() {
    const ctx = accountsEnv({ publicSignup: true });
    const ana = (await login(ctx, 'ana@example.test'))!;
    const carla = (await login(ctx, 'carla@example.test'))!;
    const club = ((await post(ctx, ana, '/api/account/clubs', { id: uuid(), name: 'Club de Ana' })).data.club as { id: string }).id;
    const other = ((await post(ctx, carla, '/api/account/clubs', { id: uuid(), name: 'Club de Carla' })).data.club as { id: string }).id;
    const inv = (await post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'bea@example.test' })).data.invitation as { id: string };
    const bea = (await login(ctx, 'bea@example.test'))!;
    expect((await post(ctx, bea, `/api/account/invitations/${inv.id}/accept`)).status).toBe(200);
    return { ctx, ana, bea, carla, club, other };
  }

  /** Invita a Dani al club de Ana y entra con su cuenta. */
  async function addDani(s: Awaited<ReturnType<typeof scene>>, accept: boolean) {
    const inv = (await post(s.ctx, s.ana, `/api/account/clubs/${s.club}/invitations`, { email: 'dani@example.test' })).data.invitation as { id: string };
    const dani = (await login(s.ctx, 'dani@example.test'))!;
    if (accept) expect((await post(s.ctx, dani, `/api/account/invitations/${inv.id}/accept`)).status).toBe(200);
    return { dani, invitationId: inv.id };
  }

  it('diez invitaciones simultáneas al mismo correo dejan una sola pendiente', async () => {
    const { ctx, ana, club } = await scene();
    const res = await Promise.all(Array.from({ length: 10 }, () => post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'Dani@Example.test' })));
    expect(res.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(res.filter((r) => r.data.created === true).length).toBe(1);
    expect(new Set(res.map((r) => (r.data.invitation as { id: string }).id)).size).toBe(1);
    expect(pending(ctx, club)).toBe(1);
    expect((await post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'no-es-un-correo' })).status).toBe(400);
    expect((await post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'bea@example.test' })).data.error).toBe('ya_es_admin');
    expect((await post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'ana@example.test' })).data.error).toBe('ya_es_propietario');
  });

  it('un administrador no invita, no retira, no transfiere ni ve lo pendiente del propietario', async () => {
    const { ctx, ana, bea, club } = await scene();
    const inv = (await post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'dani@example.test' })).data.invitation as { id: string };
    expect((await post(ctx, bea, `/api/account/clubs/${club}/invitations`, { email: 'eva@example.test' })).status).toBe(403);
    expect((await post(ctx, bea, `/api/account/clubs/${club}/invitations/${inv.id}/revoke`)).status).toBe(403);
    expect((await post(ctx, bea, `/api/account/clubs/${club}/admins/${ana.id}/revoke`)).status).toBe(403);
    expect((await post(ctx, bea, `/api/account/clubs/${club}/transfer`, { toUserId: bea.id })).status).toBe(403);
    const seen = (await get(ctx, bea, `/api/account/clubs/${club}`)).data;
    expect(seen.role).toBe('admin');
    expect(seen.invitations).toEqual([]);
    expect(seen.transfer).toBeNull();
    expect(pending(ctx, club)).toBe(1);
    expect(isAdminIn(ctx, club, bea.id)).toBe(true);
    expect(ownerOf(ctx, club)).toBe(ana.id);
  });

  it('un propietario no gestiona un club del que no es miembro (404, sin revelar nada)', async () => {
    const { ctx, ana, carla, bea, club, other } = await scene();
    expect((await post(ctx, ana, `/api/account/clubs/${other}/invitations`, { email: 'x@example.test' })).status).toBe(404);
    expect((await post(ctx, ana, `/api/account/clubs/${other}/admins/${carla.id}/revoke`)).status).toBe(404);
    expect((await post(ctx, ana, `/api/account/clubs/${other}/transfer`, { toUserId: bea.id })).status).toBe(404);
    expect((await post(ctx, carla, `/api/account/clubs/${club}/admins/${bea.id}/revoke`)).status).toBe(404);
    expect((await get(ctx, carla, `/api/account/clubs/${club}`)).status).toBe(404);
    // Una invitación de un club no se retira desde otro.
    const inv = (await post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'dani@example.test' })).data.invitation as { id: string };
    expect((await post(ctx, carla, `/api/account/clubs/${other}/invitations/${inv.id}/revoke`)).status).toBe(404);
    expect(pending(ctx, club)).toBe(1);
    expect(isAdminIn(ctx, club, bea.id)).toBe(true);
  });

  it('invitación retirada o de otro correo: no da acceso', async () => {
    const s = await scene();
    const { ctx, ana, bea, club } = s;
    const { dani, invitationId } = await addDani(s, false);
    expect((await post(ctx, bea, `/api/account/invitations/${invitationId}/accept`)).status).toBe(404);
    expect((await post(ctx, ana, `/api/account/clubs/${club}/invitations/${invitationId}/revoke`)).data).toEqual({ revoked: true });
    expect((await post(ctx, ana, `/api/account/clubs/${club}/invitations/${invitationId}/revoke`)).data).toEqual({ revoked: false });
    expect((await post(ctx, dani, `/api/account/invitations/${invitationId}/accept`)).status).toBe(404);
    expect((await get(ctx, dani, '/api/account/me')).data.invitations).toEqual([]);
    expect((await get(ctx, dani, `/api/account/clubs/${club}`)).status).toBe(404);
  });

  it('transferencia: la ve quien la recibe, cancelada no se acepta, aceptada deja un único propietario', async () => {
    const s = await scene();
    const { ctx, ana, bea, club } = s;
    const { dani } = await addDani(s, true);

    const t1 = (await post(ctx, ana, `/api/account/clubs/${club}/transfer`, { toUserId: bea.id })).data.transfer as { id: string };
    expect(((await get(ctx, bea, `/api/account/clubs/${club}`)).data.transfer as { id: string }).id).toBe(t1.id);
    expect(((await get(ctx, bea, '/api/account/me')).data.transfers as { id: string }[]).map((t) => t.id)).toEqual([t1.id]);
    expect((await get(ctx, dani, `/api/account/clubs/${club}`)).data.transfer).toBeNull();
    // Otra propuesta mientras hay una pendiente: rechazada.
    expect((await post(ctx, ana, `/api/account/clubs/${club}/transfer`, { toUserId: dani.id })).data.error).toBe('transferencia_pendiente');
    // Solo la cancela quien la propuso; cancelada, no se acepta.
    expect((await post(ctx, bea, `/api/account/transfers/${t1.id}/cancel`)).status).toBe(404);
    expect((await post(ctx, ana, `/api/account/transfers/${t1.id}/cancel`)).status).toBe(200);
    expect((await post(ctx, bea, `/api/account/transfers/${t1.id}/accept`)).status).toBe(409);
    expect(ownerOf(ctx, club)).toBe(ana.id);

    const t2 = (await post(ctx, ana, `/api/account/clubs/${club}/transfer`, { toUserId: bea.id })).data.transfer as { id: string };
    expect((await post(ctx, dani, `/api/account/transfers/${t2.id}/accept`)).status).toBe(404);
    const res = await Promise.all([
      post(ctx, bea, `/api/account/transfers/${t2.id}/accept`),
      post(ctx, bea, `/api/account/transfers/${t2.id}/accept`),
      post(ctx, ana, `/api/account/transfers/${t2.id}/cancel`),
    ]);
    expect(res.some((r) => r.status === 200)).toBe(true);
    expect(owners(ctx, club)).toBe(1);
    if (ownerOf(ctx, club) === bea.id) {
      // En la siguiente petición: Bea es propietaria y Ana administradora.
      expect((await get(ctx, bea, `/api/account/clubs/${club}`)).data.role).toBe('owner');
      expect((await get(ctx, ana, `/api/account/clubs/${club}`)).data.role).toBe('admin');
      expect((await post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'eva@example.test' })).status).toBe(403);
      expect((await post(ctx, bea, `/api/account/clubs/${club}/leave`)).data.error).toBe('propietario_activo');
    } else {
      expect(ownerOf(ctx, club)).toBe(ana.id);
      expect(isAdminIn(ctx, club, bea.id)).toBe(true);
    }
  });

  it('dejar el club o ser retirado: sin acceso en la siguiente petición; el propietario no puede irse', async () => {
    const { ctx, ana, bea, club } = await scene();
    expect((await post(ctx, ana, `/api/account/clubs/${club}/leave`)).data.error).toBe('propietario_activo');
    expect((await post(ctx, ana, `/api/account/clubs/${club}/admins/${ana.id}/revoke`)).data.error).toBe('propietario_activo');
    expect((await post(ctx, bea, `/api/account/clubs/${club}/leave`)).data).toEqual({ revoked: true });
    expect((await get(ctx, bea, `/api/account/clubs/${club}`)).status).toBe(404);
    expect((await get(ctx, bea, '/api/account/me')).data.clubs).toEqual([]);
    expect(owners(ctx, club)).toBe(1);
    // Retiradas simultáneas del mismo administrador: una sola surte efecto.
    const inv = (await post(ctx, ana, `/api/account/clubs/${club}/invitations`, { email: 'bea@example.test' })).data.invitation as { id: string };
    await post(ctx, bea, `/api/account/invitations/${inv.id}/accept`);
    const res = await Promise.all(Array.from({ length: 5 }, () => post(ctx, ana, `/api/account/clubs/${club}/admins/${bea.id}/revoke`)));
    expect(res.filter((r) => r.data.revoked === true).length).toBe(1);
    expect((await get(ctx, bea, `/api/club/${club}/me`)).status).toBe(404);
  });

  it('todas las escrituras de la sección exigen origen propio, JSON y sesión', async () => {
    const { ctx, ana, bea, club } = await scene();
    const routes = [
      `/api/account/clubs/${club}/invitations`,
      `/api/account/clubs/${club}/admins/${bea.id}/revoke`,
      `/api/account/clubs/${club}/leave`,
      `/api/account/clubs/${club}/transfer`,
      '/api/account/transfers/x/cancel',
    ];
    const body = { email: 'eva@example.test', toUserId: bea.id };
    for (const path of routes) {
      expect((await post(ctx, ana, path, body, 'https://atacante.example')).status).toBe(403);
      expect((await post(ctx, ana, path, body, null)).status).toBe(403);
      expect((await call(ctx.env, path, { cookie: ana.cookie, body: 'email=eva@example.test', contentType: 'application/x-www-form-urlencoded' })).status).toBe(415);
      expect((await post(ctx, null, path, body)).status).toBe(401);
    }
    expect(pending(ctx, club)).toBe(0);
    expect(isAdminIn(ctx, club, bea.id)).toBe(true);
    expect(ownerOf(ctx, club)).toBe(ana.id);
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM club_owner_transfers WHERE club_id = ?", club)).toBe(0);
  });
});

describe('límite de invitaciones pendientes por club', () => {
  type Who = { cookie: string; id: string };
  const invite = (ctx: Ctx, who: Who, club: string, email: string) => call(ctx.env, `/api/account/clubs/${club}/invitations`, { cookie: who.cookie, body: { email } });
  const pending = (ctx: Ctx, club: string) =>
    count(ctx.db, 'SELECT COUNT(*) AS n FROM club_invitations WHERE club_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', club, new Date().toISOString());
  const fill = async (ctx: Ctx, who: Who, club: string, n: number, prefix: string) => {
    for (let i = 0; i < n; i++) expect((await invite(ctx, who, club, `${prefix}${i}@example.test`)).status).toBe(201);
  };

  async function scene() {
    const ctx = accountsEnv({ publicSignup: true });
    const ana = (await login(ctx, 'ana@example.test'))!;
    const carla = (await login(ctx, 'carla@example.test'))!;
    const club = ((await call(ctx.env, '/api/account/clubs', { cookie: ana.cookie, body: { id: uuid(), name: 'Club de Ana' } })).data.club as { id: string }).id;
    const other = ((await call(ctx.env, '/api/account/clubs', { cookie: carla.cookie, body: { id: uuid(), name: 'Club de Carla' } })).data.club as { id: string }).id;
    return { ctx, ana, carla, club, other };
  }

  it('20 como máximo: la 21.ª se rechaza con un error claro; repetir una pendiente sigue funcionando', async () => {
    const { ctx, ana, club } = await scene();
    expect(MAX_PENDING_INVITATIONS).toBe(20);
    await fill(ctx, ana, club, 20, 'p');
    const over = await invite(ctx, ana, club, 'extra@example.test');
    expect(over.status).toBe(409);
    expect(over.data.error).toBe('limite_invitaciones');
    expect(over.data.message).toMatch(/20 invitaciones pendientes/);
    expect(pending(ctx, club)).toBe(20);
    // Repetir una que ya está pendiente no crea nada y no choca con el límite.
    const again = await invite(ctx, ana, club, 'p3@example.test');
    expect(again.status).toBe(200);
    expect(again.data.created).toBe(false);
    // Ni auditoría de la rechazada.
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM account_audit WHERE club_id = ? AND action = 'invitation.create'", club)).toBe(20);
  });

  it('retirar o aceptar una invitación libera hueco', async () => {
    const { ctx, ana, club } = await scene();
    await fill(ctx, ana, club, 19, 'p');
    expect((await invite(ctx, ana, club, 'bea@example.test')).status).toBe(201);
    expect((await invite(ctx, ana, club, 'x1@example.test')).status).toBe(409);
    const first = one<{ id: string }>(ctx.db, "SELECT id FROM club_invitations WHERE club_id = ? AND email = 'p0@example.test'", club);
    expect((await call(ctx.env, `/api/account/clubs/${club}/invitations/${first.id}/revoke`, { cookie: ana.cookie, body: {} })).status).toBe(200);
    expect((await invite(ctx, ana, club, 'x1@example.test')).status).toBe(201);
    expect((await invite(ctx, ana, club, 'x2@example.test')).status).toBe(409);
    // Bea acepta la suya: deja de estar pendiente.
    ctx.env.ACCOUNTS_PUBLIC_SIGNUP = 'false';
    const bea = (await login(ctx, 'bea@example.test'))!;
    const inv = one<{ id: string }>(ctx.db, "SELECT id FROM club_invitations WHERE club_id = ? AND email = 'bea@example.test'", club);
    expect((await call(ctx.env, `/api/account/invitations/${inv.id}/accept`, { cookie: bea.cookie, body: {} })).status).toBe(200);
    expect((await invite(ctx, ana, club, 'x2@example.test')).status).toBe(201);
    expect(pending(ctx, club)).toBe(20);
  });

  it('las caducadas no cuentan (siete días)', async () => {
    const { ctx, ana, club } = await scene();
    await fill(ctx, ana, club, 20, 'p');
    ctx.db.run("UPDATE club_invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE club_id = ? AND email IN ('p0@example.test', 'p1@example.test', 'p2@example.test')", club);
    expect(pending(ctx, club)).toBe(17);
    await fill(ctx, ana, club, 3, 'n');
    expect((await invite(ctx, ana, club, 'n3@example.test')).status).toBe(409);
    // Volver a invitar a una caducada: se cierra la vieja y, si hay hueco, se crea otra.
    const exp = one<{ expiresAt: string; createdAt: string }>(
      ctx.db,
      "SELECT expires_at AS expiresAt, created_at AS createdAt FROM club_invitations WHERE club_id = ? AND email = 'n0@example.test'",
      club,
    );
    expect(new Date(exp.expiresAt).getTime() - new Date(exp.createdAt).getTime()).toBe(7 * 86_400_000);
  });

  it('peticiones simultáneas no superan el máximo', async () => {
    const { ctx, ana, club } = await scene();
    await fill(ctx, ana, club, 15, 'p');
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => invite(ctx, ana, club, `s${i}@example.test`)));
    expect(res.filter((r) => r.status === 201).length).toBe(5);
    expect(res.filter((r) => r.status === 409 && r.data.error === 'limite_invitaciones').length).toBe(7);
    expect(pending(ctx, club)).toBe(20);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM club_invitations WHERE club_id = ?', club)).toBe(20);
  });

  it('cada club tiene su propio límite', async () => {
    const { ctx, ana, carla, club, other } = await scene();
    await fill(ctx, ana, club, 20, 'p');
    expect((await invite(ctx, ana, club, 'otra@example.test')).status).toBe(409);
    // El mismo correo y otros en el club de Carla: sin efecto del de Ana.
    expect((await invite(ctx, carla, other, 'p0@example.test')).status).toBe(201);
    expect((await invite(ctx, carla, other, 'otra@example.test')).status).toBe(201);
    expect(pending(ctx, other)).toBe(2);
    expect(pending(ctx, club)).toBe(20);
  });
});
