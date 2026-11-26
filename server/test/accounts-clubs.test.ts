// Clubes autogestionados: propietario único, administradores, invitaciones,
// transferencias, revocaciones, desactivación, aislamiento entre clubes y
// concurrencia. Base local en memoria y datos sintéticos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsEnv, call, count, login, one, sendCode, stubTurnstile, type Ctx } from './accountsHarness';
import { twoClubs } from './seed';

beforeEach(() => {
  stubTurnstile();
});
afterEach(() => vi.unstubAllGlobals());

type Who = { cookie: string; id: string };
const uuid = () => crypto.randomUUID();
const createClub = (ctx: Ctx, who: Who, name = 'Club Sintético', id: string = uuid()) => call(ctx.env, '/api/account/clubs', { cookie: who.cookie, body: { id, name } });
const invite = (ctx: Ctx, who: Who, clubId: string, email: string) => call(ctx.env, `/api/account/clubs/${clubId}/invitations`, { cookie: who.cookie, body: { email } });
const accept = (ctx: Ctx, who: Who, invitationId: string) => call(ctx.env, `/api/account/invitations/${invitationId}/accept`, { cookie: who.cookie, body: {} });
const detail = (ctx: Ctx, who: Who, clubId: string) => call(ctx.env, `/api/account/clubs/${clubId}`, { cookie: who.cookie });
const transfer = (ctx: Ctx, who: Who, clubId: string, toUserId: string) => call(ctx.env, `/api/account/clubs/${clubId}/transfer`, { cookie: who.cookie, body: { toUserId } });
const decide = (ctx: Ctx, who: Who, id: string, d: 'accept' | 'decline' | 'cancel') => call(ctx.env, `/api/account/transfers/${id}/${d}`, { cookie: who.cookie, body: {} });
const revoke = (ctx: Ctx, who: Who, clubId: string, userId: string) => call(ctx.env, `/api/account/clubs/${clubId}/admins/${userId}/revoke`, { cookie: who.cookie, body: {} });
const ownerOf = (ctx: Ctx, clubId: string) => one<{ u: string } | undefined>(ctx.db, 'SELECT user_id AS u FROM club_owners WHERE club_id = ?', clubId)?.u ?? null;
const isAdmin = (ctx: Ctx, clubId: string, userId: string) =>
  count(ctx.db, 'SELECT COUNT(*) AS n FROM club_memberships WHERE club_id = ? AND user_id = ? AND revoked_at IS NULL', clubId, userId) === 1;
const sqlError = (ctx: Ctx, sql: string, ...v: string[]) => {
  try {
    ctx.db.run(sql, ...v);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
};

/** Invariantes globales: se comprueban al final de cada escenario. */
function assertInvariants(ctx: Ctx) {
  // Ningún club creado por una cuenta sin propietario.
  expect(count(ctx.db, "SELECT COUNT(*) AS n FROM clubs c WHERE c.id IN (SELECT club_id FROM account_audit WHERE action = 'club.create') AND NOT EXISTS (SELECT 1 FROM club_owners o WHERE o.club_id = c.id)")).toBe(0);
  // Nadie es propietario y administrador a la vez del mismo club.
  expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM club_memberships m JOIN club_owners o ON o.club_id = m.club_id AND o.user_id = m.user_id WHERE m.revoked_at IS NULL')).toBe(0);
  // Ningún propietario ni administrador desactivado.
  expect(count(ctx.db, "SELECT COUNT(*) AS n FROM club_owners o JOIN account_state s ON s.user_id = o.user_id WHERE s.status = 'disabled'")).toBe(0);
  expect(count(ctx.db, "SELECT COUNT(*) AS n FROM club_memberships m JOIN account_state s ON s.user_id = m.user_id WHERE s.status = 'disabled' AND m.revoked_at IS NULL")).toBe(0);
  // Como mucho una transferencia y una invitación pendientes por club (y correo).
  expect(count(ctx.db, "SELECT COUNT(*) AS n FROM (SELECT club_id FROM club_owner_transfers WHERE status = 'pending' GROUP BY club_id HAVING COUNT(*) > 1)")).toBe(0);
}

describe('alta de club con registro libre', () => {
  let ctx: Ctx;
  let ana: Who;
  beforeEach(async () => {
    ctx = accountsEnv({ publicSignup: true });
    ana = (await login(ctx, 'ana@example.test'))!;
  });
  afterEach(() => assertInvariants(ctx));

  it('crea el club con la cuenta como propietaria, en una operación', async () => {
    const r = await createClub(ctx, ana, '  CB Sintético  ');
    expect(r.status).toBe(201);
    const id = (r.data.club as { id: string }).id;
    expect(ownerOf(ctx, id)).toBe(ana.id);
    expect(one<{ name: string; status: string }>(ctx.db, 'SELECT name, status FROM clubs WHERE id = ?', id)).toEqual({ name: 'CB Sintético', status: 'active' });
    const me = await call(ctx.env, '/api/account/me', { cookie: ana.cookie });
    expect(me.data.clubs).toEqual([{ id, name: 'CB Sintético', role: 'owner' }]);
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM account_audit WHERE action = 'club.create' AND club_id = ?", id)).toBe(1);
  });

  it('reintento con el mismo identificador: el mismo club, sin duplicar', async () => {
    const id = uuid();
    const res = await Promise.all(Array.from({ length: 5 }, () => createClub(ctx, ana, 'Uno', id)));
    expect(res.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(res.filter((r) => r.data.created === true).length).toBe(1);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM clubs WHERE id = ?', id)).toBe(1);
    const bea = (await login(ctx, 'bea@example.test'))!;
    expect((await createClub(ctx, bea, 'Otro', id)).status).toBe(409);
  });

  it('datos no válidos y límite diario', async () => {
    expect((await createClub(ctx, ana, '', uuid())).status).toBe(400);
    expect((await createClub(ctx, ana, 'x'.repeat(81), uuid())).status).toBe(400);
    expect((await call(ctx.env, '/api/account/clubs', { cookie: ana.cookie, body: { id: 'no-uuid', name: 'X' } })).status).toBe(400);
    const st = [];
    for (let i = 0; i < 4; i++) st.push((await createClub(ctx, ana, `Club ${i}`)).status);
    expect(st).toEqual([201, 201, 201, 429]);
  });

  it('sin registro libre no se pueden crear clubes', async () => {
    ctx.env.ACCOUNTS_PUBLIC_SIGNUP = 'false';
    const r = await createClub(ctx, ana);
    expect(r.status).toBe(403);
    expect(r.data.error).toBe('signup_closed');
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM clubs')).toBe(0);
  });
});

describe('integridad del propietario en la base', () => {
  let ctx: Ctx;
  let ana: Who;
  let club: string;
  beforeEach(async () => {
    ctx = accountsEnv({ publicSignup: true });
    ana = (await login(ctx, 'ana@example.test'))!;
    club = ((await createClub(ctx, ana)).data.club as { id: string }).id;
  });

  it('no se puede borrar, vaciar, duplicar ni mover el propietario', () => {
    expect(sqlError(ctx, 'DELETE FROM club_owners WHERE club_id = ?', club)).toMatch(/club_sin_propietario/);
    expect(sqlError(ctx, 'UPDATE club_owners SET user_id = NULL WHERE club_id = ?', club)).toMatch(/NOT NULL|propietario_no_valido/);
    expect(sqlError(ctx, "INSERT INTO club_owners (club_id, user_id, since) VALUES (?, ?, 'x')", club, ana.id)).toMatch(/UNIQUE|PRIMARY/);
    expect(sqlError(ctx, "UPDATE club_owners SET club_id = 'otro' WHERE club_id = ?", club)).toMatch(/propietario_no_valido/);
    expect(sqlError(ctx, "UPDATE club_owners SET user_id = 'no-existe' WHERE club_id = ?", club)).toMatch(/propietario_no_valido/);
    expect(ownerOf(ctx, club)).toBe(ana.id);
  });

  it('borrar el club (superadministración) sí elimina su propietario', () => {
    expect(sqlError(ctx, 'DELETE FROM clubs WHERE id = ?', club)).toBeNull();
    expect(ownerOf(ctx, club)).toBeNull();
  });

  it('si falla el propietario, no queda club: el alta es todo o nada', async () => {
    const bea = (await login(ctx, 'bea@example.test'))!;
    ctx.db.run("INSERT INTO account_state (user_id, status, disabled_at, disabled_reason, updated_at) VALUES (?, 'disabled', 'x', 'superadmin', 'x')", bea.id);
    const before = count(ctx.db, 'SELECT COUNT(*) AS n FROM clubs');
    const attempts = count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_attempts');
    // Llamada directa al servicio: con la cuenta desactivada, la API ya rechazaría la sesión.
    const { createOwnedClub } = await import('../src/accounts/clubs');
    const id = uuid();
    await expect(createOwnedClub(ctx.db, { id: bea.id, email: 'bea@example.test', emailVerified: true }, { id, name: 'Huérfano' }, 'p'.repeat(40))).rejects.toMatchObject({ status: 409 });
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM clubs')).toBe(before);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM clubs WHERE id = ?', id)).toBe(0);
    // Ni siquiera queda contado el intento: todo el batch se deshace.
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM auth_attempts')).toBe(attempts);
  });
});

describe('invitaciones', () => {
  let ctx: Ctx;
  let ana: Who;
  let club: string;
  beforeEach(async () => {
    ctx = accountsEnv({ publicSignup: true });
    ana = (await login(ctx, 'ana@example.test'))!;
    club = ((await createClub(ctx, ana)).data.club as { id: string }).id;
    ctx.env.ACCOUNTS_PUBLIC_SIGNUP = 'false'; // desde aquí, solo se entra por invitación
  });
  afterEach(() => assertInvariants(ctx));

  it('la invitada crea su cuenta con el código, ve la invitación y la acepta', async () => {
    expect(await login(ctx, 'bea@example.test')).toBeNull(); // sin invitación no hay código
    const inv = await invite(ctx, ana, club, ' Bea@Example.test ');
    expect(inv.status).toBe(201);
    const invitationId = (inv.data.invitation as { id: string }).id;
    const again = await invite(ctx, ana, club, 'bea@example.test');
    expect(again.status).toBe(200);
    expect((again.data.invitation as { id: string }).id).toBe(invitationId);

    const bea = (await login(ctx, 'bea@example.test'))!;
    expect(bea).not.toBeNull();
    const me = await call(ctx.env, '/api/account/me', { cookie: bea.cookie });
    expect((me.data.invitations as { id: string }[]).map((i) => i.id)).toEqual([invitationId]);
    expect((await accept(ctx, bea, invitationId)).status).toBe(200);
    expect(isAdmin(ctx, club, bea.id)).toBe(true);
    const retry = await accept(ctx, bea, invitationId);
    expect(retry.status).toBe(200);
    expect(retry.data.accepted).toBe(false);
    expect((await detail(ctx, bea, club)).data.role).toBe('admin');
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM account_audit WHERE club_id = ? AND action IN ('invitation.create', 'invitation.accept')", club)).toBe(2);
  });

  it('otra cuenta no puede aceptarla; diez aceptaciones simultáneas dan una membresía', async () => {
    const inv = (await invite(ctx, ana, club, 'bea@example.test')).data.invitation as { id: string };
    await invite(ctx, ana, club, 'carla@example.test');
    const bea = (await login(ctx, 'bea@example.test'))!;
    const carla = (await login(ctx, 'carla@example.test'))!;
    expect((await accept(ctx, carla, inv.id)).status).toBe(404);
    const res = await Promise.all(Array.from({ length: 10 }, () => accept(ctx, bea, inv.id)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(res.filter((r) => r.data.accepted === true).length).toBe(1);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM club_memberships WHERE club_id = ? AND user_id = ?', club, bea.id)).toBe(1);
    expect(isAdmin(ctx, club, carla.id)).toBe(false);
  });

  it('caducada: no permite crear la cuenta ni aceptarla; se puede invitar de nuevo', async () => {
    const inv = (await invite(ctx, ana, club, 'dani@example.test')).data.invitation as { id: string };
    ctx.db.run("UPDATE club_invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", inv.id);
    expect(await login(ctx, 'dani@example.test')).toBeNull();
    const fresh = await invite(ctx, ana, club, 'dani@example.test');
    expect(fresh.status).toBe(201);
    const dani = (await login(ctx, 'dani@example.test'))!;
    const late = await accept(ctx, dani, inv.id);
    expect(late.status).toBe(404); // la caducada quedó cerrada al invitar de nuevo
    expect((await accept(ctx, dani, (fresh.data.invitation as { id: string }).id)).status).toBe(200);
  });

  it('caducada con la cuenta ya creada: 410 y sin membresía', async () => {
    const inv = (await invite(ctx, ana, club, 'eva@example.test')).data.invitation as { id: string };
    const eva = (await login(ctx, 'eva@example.test'))!;
    ctx.db.run("UPDATE club_invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", inv.id);
    const r = await accept(ctx, eva, inv.id);
    expect(r.status).toBe(410);
    expect(isAdmin(ctx, club, eva.id)).toBe(false);
  });

  it('retirada o rechazada: no se acepta ni se reabre', async () => {
    const inv = (await invite(ctx, ana, club, 'fer@example.test')).data.invitation as { id: string };
    const fer = (await login(ctx, 'fer@example.test'))!;
    expect((await call(ctx.env, `/api/account/clubs/${club}/invitations/${inv.id}/revoke`, { cookie: ana.cookie, body: {} })).data.revoked).toBe(true);
    expect((await accept(ctx, fer, inv.id)).status).toBe(404);
    expect(sqlError(ctx, 'UPDATE club_invitations SET revoked_at = NULL WHERE id = ?', inv.id)).toMatch(/invitacion_cerrada/);
    const inv2 = (await invite(ctx, ana, club, 'fer@example.test')).data.invitation as { id: string };
    expect((await call(ctx.env, `/api/account/invitations/${inv2.id}/decline`, { cookie: fer.cookie, body: {} })).data.declined).toBe(true);
    expect((await accept(ctx, fer, inv2.id)).status).toBe(404);
  });

  it('una membresía no se mueve y una invitación pendiente no se redirige', async () => {
    const inv = (await invite(ctx, ana, club, 'hugo@example.test')).data.invitation as { id: string };
    expect(sqlError(ctx, "UPDATE club_invitations SET email = 'atacante@example.test' WHERE id = ?", inv.id)).toMatch(/invitacion_inmutable/);
    expect(sqlError(ctx, "UPDATE club_invitations SET club_id = 'otro' WHERE id = ?", inv.id)).toMatch(/invitacion_inmutable/);
    const hugo = (await login(ctx, 'hugo@example.test'))!;
    await accept(ctx, hugo, inv.id);
    const otherClub = uuid();
    ctx.db.run("INSERT INTO clubs (id, name, created_at, updated_at) VALUES (?, 'Otro', 'x', 'x')", otherClub);
    expect(sqlError(ctx, 'UPDATE club_memberships SET club_id = ? WHERE user_id = ?', otherClub, hugo.id)).toMatch(/membresia_inmutable/);
    expect(sqlError(ctx, 'UPDATE club_memberships SET user_id = ? WHERE user_id = ?', ana.id, hugo.id)).toMatch(/membresia_inmutable/);
    expect(isAdmin(ctx, club, hugo.id)).toBe(true);
  });

  it('no se invita a quien ya es propietario o administrador; un administrador no invita', async () => {
    expect((await invite(ctx, ana, club, 'ana@example.test')).status).toBe(409);
    const inv = (await invite(ctx, ana, club, 'gema@example.test')).data.invitation as { id: string };
    const gema = (await login(ctx, 'gema@example.test'))!;
    await accept(ctx, gema, inv.id);
    expect((await invite(ctx, ana, club, 'gema@example.test')).status).toBe(409);
    const r = await invite(ctx, gema, club, 'otra@example.test');
    expect(r.status).toBe(403);
    expect(r.data.error).toBe('owner_required');
    expect((await invite(ctx, ana, club, 'no-es-correo')).status).toBe(400);
  });
});

describe('transferencia de propiedad', () => {
  let ctx: Ctx;
  let ana: Who;
  let bea: Who;
  let carla: Who;
  let club: string;
  beforeEach(async () => {
    ctx = accountsEnv({ publicSignup: true });
    ana = (await login(ctx, 'ana@example.test'))!;
    club = ((await createClub(ctx, ana)).data.club as { id: string }).id;
    bea = (await login(ctx, 'bea@example.test'))!;
    carla = (await login(ctx, 'carla@example.test'))!;
    for (const [who, email] of [
      [bea, 'bea@example.test'],
      [carla, 'carla@example.test'],
    ] as const) {
      const inv = (await invite(ctx, ana, club, email)).data.invitation as { id: string };
      await accept(ctx, who, inv.id);
    }
  });
  afterEach(() => assertInvariants(ctx));

  it('solo a un administrador, solo la inicia el propietario, una pendiente por club', async () => {
    const out = (await login(ctx, 'dani@example.test'))!;
    expect((await transfer(ctx, ana, club, out.id)).status).toBe(409);
    expect((await transfer(ctx, bea, club, bea.id)).data.error).toBe('owner_required');
    const t = await transfer(ctx, ana, club, bea.id);
    expect(t.status).toBe(201);
    expect((await transfer(ctx, ana, club, bea.id)).data.created).toBe(false);
    expect((await transfer(ctx, ana, club, carla.id)).data.error).toBe('transferencia_pendiente');
    expect(ownerOf(ctx, club)).toBe(ana.id);
  });

  it('la acepta solo quien la recibe; el anterior propietario pasa a administrador', async () => {
    const id = ((await transfer(ctx, ana, club, bea.id)).data.transfer as { id: string }).id;
    expect((await decide(ctx, carla, id, 'accept')).status).toBe(404);
    expect((await decide(ctx, ana, id, 'accept')).status).toBe(404);
    const r = await decide(ctx, bea, id, 'accept');
    expect(r.status).toBe(200);
    expect(ownerOf(ctx, club)).toBe(bea.id);
    expect(isAdmin(ctx, club, ana.id)).toBe(true);
    expect(isAdmin(ctx, club, bea.id)).toBe(false);
    expect((await decide(ctx, bea, id, 'accept')).data.changed).toBe(false);
    expect((await decide(ctx, bea, id, 'decline')).status).toBe(409);
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM account_audit WHERE club_id = ? AND action = 'ownership.accept'", club)).toBe(1);
    expect((await detail(ctx, ana, club)).data.role).toBe('admin');
  });

  it('caducada, rechazada o cancelada: el propietario no cambia', async () => {
    let id = ((await transfer(ctx, ana, club, bea.id)).data.transfer as { id: string }).id;
    ctx.db.run("UPDATE club_owner_transfers SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", id);
    expect((await decide(ctx, bea, id, 'accept')).status).toBe(410);
    // Una caducada no bloquea la siguiente.
    id = ((await transfer(ctx, ana, club, bea.id)).data.transfer as { id: string }).id;
    expect((await decide(ctx, bea, id, 'decline')).data.status).toBe('declined');
    id = ((await transfer(ctx, ana, club, bea.id)).data.transfer as { id: string }).id;
    expect((await decide(ctx, ana, id, 'cancel')).data.status).toBe('cancelled');
    expect((await decide(ctx, bea, id, 'accept')).status).toBe(409);
    expect(ownerOf(ctx, club)).toBe(ana.id);
  });

  it('aceptar y cancelar a la vez: una sola decisión y estado coherente (varias rondas)', async () => {
    for (let round = 0; round < 6; round++) {
      const owner = ownerOf(ctx, club) === ana.id ? ana : bea;
      const target = owner === ana ? bea : ana;
      const id = ((await transfer(ctx, owner, club, target.id)).data.transfer as { id: string }).id;
      const res = await Promise.all([
        ...Array.from({ length: 6 }, () => decide(ctx, target, id, 'accept')),
        ...Array.from({ length: 6 }, () => decide(ctx, owner, id, 'cancel')),
      ]);
      const status = one<{ status: string }>(ctx.db, 'SELECT status FROM club_owner_transfers WHERE id = ?', id).status;
      expect(res.filter((r) => r.data.changed === true).length).toBe(1);
      expect(['accepted', 'cancelled']).toContain(status);
      const expected = status === 'accepted' ? target : owner;
      expect(ownerOf(ctx, club)).toBe(expected.id);
      expect(isAdmin(ctx, club, expected === ana ? bea.id : ana.id)).toBe(true);
      expect(isAdmin(ctx, club, expected.id)).toBe(false);
      assertInvariants(ctx);
    }
  });

  it('transferencia y revocación simultáneas del destinatario: nunca dos propietarios ni ninguno', async () => {
    for (let round = 0; round < 6; round++) {
      const owner = ownerOf(ctx, club) === ana.id ? ana : bea;
      const target = owner === ana ? bea : ana;
      if (!isAdmin(ctx, club, target.id)) {
        const inv = (await invite(ctx, owner, club, target === ana ? 'ana@example.test' : 'bea@example.test')).data.invitation as { id: string };
        await accept(ctx, target, inv.id);
      }
      const id = ((await transfer(ctx, owner, club, target.id)).data.transfer as { id: string }).id;
      const [acc, rev] = await Promise.all([decide(ctx, target, id, 'accept'), revoke(ctx, owner, club, target.id)]);
      const status = one<{ status: string }>(ctx.db, 'SELECT status FROM club_owner_transfers WHERE id = ?', id).status;
      expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM club_owners WHERE club_id = ?', club)).toBe(1);
      if (status === 'accepted') {
        expect(ownerOf(ctx, club)).toBe(target.id);
        expect(acc.status).toBe(200);
      } else {
        expect(status).toBe('cancelled');
        expect(ownerOf(ctx, club)).toBe(owner.id);
        expect(rev.data.revoked).toBe(true);
        expect(isAdmin(ctx, club, target.id)).toBe(false);
      }
      assertInvariants(ctx);
    }
  });

  it('revocar al destinatario cancela la transferencia; pierde el acceso al instante', async () => {
    const id = ((await transfer(ctx, ana, club, bea.id)).data.transfer as { id: string }).id;
    expect((await revoke(ctx, ana, club, bea.id)).data.revoked).toBe(true);
    expect(one<{ status: string }>(ctx.db, 'SELECT status FROM club_owner_transfers WHERE id = ?', id).status).toBe('cancelled');
    expect((await detail(ctx, bea, club)).status).toBe(404);
    expect((await decide(ctx, bea, id, 'accept')).status).toBe(409);
    expect((await revoke(ctx, ana, club, bea.id)).data.revoked).toBe(false); // idempotente
  });

  it('un administrador no transfiere, no revoca y puede dejar el club; el propietario no puede irse', async () => {
    expect((await revoke(ctx, bea, club, carla.id)).data.error).toBe('owner_required');
    expect((await call(ctx.env, `/api/account/clubs/${club}/leave`, { cookie: ana.cookie, body: {} })).status).toBe(409);
    expect((await call(ctx.env, `/api/account/clubs/${club}/leave`, { cookie: carla.cookie, body: {} })).data.revoked).toBe(true);
    expect((await detail(ctx, carla, club)).status).toBe(404);
    expect(sqlError(ctx, 'UPDATE club_memberships SET revoked_at = NULL WHERE club_id = ? AND user_id = ?', club, carla.id)).toMatch(/membresia_cerrada/);
  });
});

describe('desactivación de cuentas', () => {
  let ctx: Ctx;
  let ana: Who;
  let bea: Who;
  let club: string;
  beforeEach(async () => {
    ctx = accountsEnv({ publicSignup: true });
    ana = (await login(ctx, 'ana@example.test'))!;
    club = ((await createClub(ctx, ana)).data.club as { id: string }).id;
    bea = (await login(ctx, 'bea@example.test'))!;
    const inv = (await invite(ctx, ana, club, 'bea@example.test')).data.invitation as { id: string };
    await accept(ctx, bea, inv.id);
  });
  afterEach(() => assertInvariants(ctx));

  it('un propietario no puede desactivarse: se rechaza todo, sin efectos parciales', async () => {
    await transfer(ctx, ana, club, bea.id);
    const r = await call(ctx.env, '/api/account/deactivate', { cookie: ana.cookie, body: {} });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe('propietario_activo');
    expect((await call(ctx.env, '/api/account/me', { cookie: ana.cookie })).status).toBe(200);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM account_state')).toBe(0);
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM club_owner_transfers WHERE status = 'pending'")).toBe(1);
  });

  it('un administrador sí: membresías, transferencias, invitaciones y sesiones, de una vez', async () => {
    const second = (await login(ctx, 'bea@example.test'))!;
    const tr = ((await transfer(ctx, ana, club, bea.id)).data.transfer as { id: string }).id;
    const r = await call(ctx.env, '/api/account/deactivate', { cookie: bea.cookie, body: {} });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ disabled: true, membershipsRevoked: 1, sessionsClosed: 2 });
    expect((await call(ctx.env, '/api/account/me', { cookie: second.cookie })).status).toBe(401);
    expect(isAdmin(ctx, club, bea.id)).toBe(false);
    expect(one<{ status: string }>(ctx.db, 'SELECT status FROM club_owner_transfers WHERE id = ?', tr).status).toBe('cancelled');
    // No puede volver a ser administradora ni propietaria.
    expect(sqlError(ctx, "INSERT INTO club_memberships (id, club_id, user_id, role, source, created_at) VALUES ('x', ?, ?, 'admin', 'invitation', 'x')", club, bea.id)).toMatch(/cuenta_desactivada/);
    expect(sqlError(ctx, 'UPDATE club_owners SET user_id = ? WHERE club_id = ?', bea.id, club)).toMatch(/propietario_no_valido/);
    expect(await login(ctx, 'bea@example.test')).toBeNull();
    // Reintento: idempotente (la sesión ya no existe, así que se hace como superadministración).
    const { deactivateAccount } = await import('../src/accounts/clubs');
    await expect(deactivateAccount(ctx.db, bea.id, null, 'superadmin')).resolves.toMatchObject({ disabled: true, membershipsRevoked: 0, sessionsClosed: 0 });
  });
});

describe('aislamiento y usuarios sin membresía', () => {
  let ctx: Ctx;
  let ana: Who;
  let bea: Who;
  let clubA: string;
  let clubB: string;
  beforeEach(async () => {
    ctx = accountsEnv({ publicSignup: true });
    twoClubs(ctx.db); // clubes existentes (como el Burjassot): sin propietario
    ana = (await login(ctx, 'ana@example.test'))!;
    bea = (await login(ctx, 'bea@example.test'))!;
    clubA = ((await createClub(ctx, ana, 'Club de Ana')).data.club as { id: string }).id;
    clubB = ((await createClub(ctx, bea, 'Club de Bea')).data.club as { id: string }).id;
  });
  afterEach(() => assertInvariants(ctx));

  it('una cuenta sin membresía no ve ni toca el club (404, sin revelar si existe)', async () => {
    const nadie = (await login(ctx, 'nadie@example.test'))!;
    for (const path of [`/api/account/clubs/${clubA}`, `/api/account/clubs/${uuid()}`]) expect((await call(ctx.env, path, { cookie: nadie.cookie })).status).toBe(404);
    expect((await invite(ctx, nadie, clubA, 'x@example.test')).status).toBe(404);
    expect((await transfer(ctx, nadie, clubA, nadie.id)).status).toBe(404);
    expect((await revoke(ctx, nadie, clubA, ana.id)).status).toBe(404);
    expect((await call(ctx.env, `/api/account/clubs/${clubA}/leave`, { cookie: nadie.cookie, body: {} })).status).toBe(404);
  });

  it('el propietario de un club no tiene permisos en otro', async () => {
    expect((await detail(ctx, ana, clubB)).status).toBe(404);
    expect((await invite(ctx, ana, clubB, 'x@example.test')).status).toBe(404);
    expect((await transfer(ctx, ana, clubB, ana.id)).status).toBe(404);
    expect((await revoke(ctx, bea, clubA, ana.id)).status).toBe(404);
    const la = ((await call(ctx.env, '/api/account/me', { cookie: ana.cookie })).data.clubs as { id: string }[]).map((c) => c.id);
    expect(la).toEqual([clubA]);
  });

  it('una cuenta puede ser propietaria de un club y administradora de otro, con permisos separados', async () => {
    const inv = (await invite(ctx, bea, clubB, 'ana@example.test')).data.invitation as { id: string };
    await accept(ctx, ana, inv.id);
    const clubs = (await call(ctx.env, '/api/account/me', { cookie: ana.cookie })).data.clubs as { id: string; role: string }[];
    expect(clubs.map((c) => `${c.id === clubA ? 'A' : 'B'}:${c.role}`).sort()).toEqual(['A:owner', 'B:admin']);
    expect((await invite(ctx, ana, clubB, 'x@example.test')).status).toBe(403);
    expect((await invite(ctx, ana, clubA, 'x@example.test')).status).toBe(201);
  });

  it('los clubes existentes siguen sin propietario y no se gestionan desde las cuentas', async () => {
    expect(count(ctx.db, "SELECT COUNT(*) AS n FROM club_owners WHERE club_id IN ('A', 'B')")).toBe(0);
    expect((await detail(ctx, ana, 'A')).status).toBe(404);
    expect((await invite(ctx, ana, 'A', 'x@example.test')).status).toBe(404);
    expect((await createClub(ctx, ana, 'Intruso', 'A')).status).toBe(400);
  });

  it('una sesión revocada pierde el acceso al club al instante', async () => {
    await call(ctx.env, '/api/account/auth/revoke-sessions', { cookie: ana.cookie, body: {} });
    expect((await detail(ctx, ana, clubA)).status).toBe(401);
    expect(await sendCode(ctx.env, 'ana@example.test')).toMatchObject({ status: 200 });
  });
});
