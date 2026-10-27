import { beforeEach, describe, expect, it } from 'vitest';
import { authenticate, authorize, authorizeClub, authorizePlatform, effectiveRole } from '../src/auth';
import { HttpError } from '../src/errors';
import type { AuthContext, Role } from '../src/model';
import { clubRoleAllows, isReadOnly, roleAllows, type Action, type ClubAction } from '../src/permissions';
import { addAdmin, addDevice, NOW, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const ACTIONS: Action[] = ['team.read', 'match.write', 'roster.write', 'match.transfer', 'team.manage', 'invites.manage', 'grants.manage'];
const CLUB_ACTIONS: ClubAction[] = ['club.read', 'club.manage', 'club.teams.manage', 'club.admins.manage'];

async function status(p: Promise<unknown> | (() => unknown)): Promise<number | string> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    if (e instanceof HttpError) return e.status === 401 && e.code !== 'unauthorized' ? e.code : e.status;
    throw e;
  }
}

describe('matriz de permisos', () => {
  it.each<[Role, Action[]]>([
    ['superadmin', ACTIONS],
    ['club_admin', ACTIONS],
    ['coach', ['team.read', 'match.write', 'roster.write', 'match.transfer']],
    ['viewer', ['team.read']],
  ])('equipo: %s', (role, allowed) => {
    expect(ACTIONS.filter((a) => roleAllows(role, a))).toEqual(allowed);
  });

  it('club: el superadministrador todo; el administrador de club no nombra administradores', () => {
    expect(CLUB_ACTIONS.filter((a) => clubRoleAllows('superadmin', a))).toEqual(CLUB_ACTIONS);
    expect(CLUB_ACTIONS.filter((a) => clubRoleAllows('club_admin', a))).toEqual(['club.read', 'club.manage', 'club.teams.manage']);
  });

  it('consulta no puede hacer ninguna escritura; el entrenador no gestiona accesos', () => {
    for (const a of ACTIONS.filter((x) => !isReadOnly(x))) expect(roleAllows('viewer', a)).toBe(false);
    expect(roleAllows('coach', 'grants.manage')).toBe(false);
    expect(roleAllows('coach', 'invites.manage')).toBe(false);
    expect(roleAllows('coach', 'team.manage')).toBe(false);
  });
});

describe('autenticación', () => {
  let db: SqliteD1;
  beforeEach(() => {
    db = migratedDb();
    twoClubs(db);
  });

  it('rechaza tokens ausentes, desconocidos, revocados, caducados o de dispositivos revocados', async () => {
    const { token } = await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect(await status(authenticate(db, null, PEPPER))).toBe(401);
    expect(await status(authenticate(db, 'inventado', PEPPER))).toBe(401);
    expect(await status(authenticate(db, token, 'otra-clave'))).toBe(401);
    expect(await status(authenticate(db, token, PEPPER))).toBe('ok');

    db.run("UPDATE device_tokens SET expires_at = '2026-01-01T00:00:00.000Z'");
    expect(await status(authenticate(db, token, PEPPER))).toBe(401);
    db.run('UPDATE device_tokens SET expires_at = NULL, revoked_at = ?', NOW);
    expect(await status(authenticate(db, token, PEPPER))).toBe(401);
    db.run('UPDATE device_tokens SET revoked_at = NULL');
    db.run('UPDATE devices SET revoked_at = ?', NOW);
    expect(await status(authenticate(db, token, PEPPER))).toBe(401);
  });

  it('tokens y sesiones no se guardan en claro', async () => {
    const { token } = await addDevice(db, 'd1', []);
    const admin = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    const dump = JSON.stringify([db.sqlite.prepare('SELECT * FROM device_tokens').all(), db.sqlite.prepare('SELECT * FROM admin_sessions').all()]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(admin.token);
  });

  it('un dispositivo de entrenador o consulta nunca tiene roles administrativos', async () => {
    const { auth } = await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect(auth.admin).toBeUndefined();
  });

  it('la sesión administrativa caduca, se revoca y deja de valer si se desactiva la identidad', async () => {
    const { token } = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    expect((await authenticate(db, token, PEPPER)).admin?.roles).toEqual([{ role: 'superadmin', clubId: null }]);
    db.run("UPDATE admin_identities SET disabled_at = ? WHERE id = 'sa'", NOW);
    expect(await status(authenticate(db, token, PEPPER))).toBe(401);
    db.run("UPDATE admin_identities SET disabled_at = NULL WHERE id = 'sa'");
    db.run('UPDATE admin_sessions SET revoked_at = ?', NOW);
    expect(await status(authenticate(db, token, PEPPER))).toBe(401);
    db.run("UPDATE admin_sessions SET revoked_at = NULL, expires_at = '2026-01-01T00:00:00.000Z'");
    expect(await status(authenticate(db, token, PEPPER))).toBe(401);
  });

  it('no hay sesión administrativa sin verificación fuerte (la base de datos la exige)', () => {
    db.run("INSERT INTO admin_identities (id, display_name, created_at) VALUES ('x', 'X', ?)", NOW);
    db.run("INSERT INTO devices (id, created_at) VALUES ('dx', ?)", NOW);
    expect(() =>
      db.run("INSERT INTO admin_sessions (token_hash, identity_id, device_id, created_at, expires_at) VALUES ('h', 'x', 'dx', ?, ?)", NOW, NOW),
    ).toThrow(/NOT NULL/);
  });

  it('una sesión administrativa conserva los permisos de equipo de su dispositivo', async () => {
    const { identityId, deviceId } = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    db.run("INSERT INTO grants (id, device_id, club_id, team_id, role, created_at) VALUES ('g', ?, 'B', 'b1', 'viewer', ?)", deviceId, NOW);
    const token = 'token-de-prueba-sesion-2';
    const { hashSecret } = await import('../src/secrets');
    db.run(
      "INSERT INTO admin_sessions (token_hash, identity_id, device_id, created_at, expires_at, mfa_verified_at) VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?)",
      await hashSecret(token, PEPPER),
      identityId,
      deviceId,
      NOW,
      NOW,
    );
    const auth = await authenticate(db, token, PEPPER);
    expect(effectiveRole(auth, { id: 'a2', clubId: 'A' })).toBe('club_admin');
    expect(effectiveRole(auth, { id: 'b1', clubId: 'B' })).toBe('viewer');
  });
});

describe('autorización de equipos y aislamiento', () => {
  let db: SqliteD1;
  beforeEach(() => {
    db = migratedDb();
    twoClubs(db);
  });

  it('consulta: lee su equipo, cualquier escritura es 403 y otros equipos 404', async () => {
    const { auth } = await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }]);
    expect(await status(authorize(db, auth, 'a1', 'team.read'))).toBe('ok');
    for (const action of ACTIONS.filter((a) => !isReadOnly(a))) expect(await status(authorize(db, auth, 'a1', action))).toBe(403);
    expect(await status(authorize(db, auth, 'a2', 'team.read'))).toBe(404);
    expect(await status(authorize(db, auth, 'b1', 'team.read'))).toBe(404);
  });

  it('entrenador: registra en sus equipos, sin gestionar accesos ni ver otros equipos', async () => {
    const { auth } = await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect(await status(authorize(db, auth, 'a1', 'match.write'))).toBe('ok');
    expect(await status(authorize(db, auth, 'a1', 'grants.manage'))).toBe(403);
    expect(await status(authorize(db, auth, 'a1', 'invites.manage'))).toBe(403);
    expect(await status(authorize(db, auth, 'a2', 'team.read'))).toBe(404);
    expect(await status(authorizeClub(db, auth, 'A', 'club.read'))).toBe(404);
  });

  it('administrador de club: edita partidos y gestiona todos los equipos de SU club, ninguno de otro', async () => {
    const { auth } = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    for (const team of ['a1', 'a2']) {
      for (const action of ACTIONS) expect(await status(authorize(db, auth, team, action))).toBe('ok');
    }
    expect(await status(authorize(db, auth, 'b1', 'team.read'))).toBe(404);
    expect(await status(authorizeClub(db, auth, 'A', 'club.teams.manage'))).toBe('ok');
    expect(await status(authorizeClub(db, auth, 'B', 'club.read'))).toBe(404);
  });

  it('superadministrador: todos los equipos de todos los clubes', async () => {
    const { auth } = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    for (const team of ['a1', 'a2', 'b1']) expect(await status(authorize(db, auth, team, 'grants.manage'))).toBe('ok');
    for (const club of ['A', 'B']) expect(await status(authorizeClub(db, auth, club, 'club.admins.manage'))).toBe('ok');
    expect(await status(() => authorizePlatform(auth, 'platform.clubs.manage'))).toBe('ok');
  });

  it('un dispositivo o identidad puede acumular permisos, cada uno en su ámbito', async () => {
    const { auth } = await addDevice(db, 'd1', [
      { clubId: 'A', teamId: 'a1', role: 'coach' },
      { clubId: 'B', teamId: 'b1', role: 'viewer' },
    ]);
    expect(await status(authorize(db, auth, 'a1', 'match.write'))).toBe('ok');
    expect(await status(authorize(db, auth, 'b1', 'match.write'))).toBe(403);
    const two = await addAdmin(db, 'ca2', [
      { role: 'club_admin', clubId: 'A' },
      { role: 'club_admin', clubId: 'B' },
    ]);
    expect(await status(authorize(db, two.auth, 'b1', 'match.write'))).toBe('ok');
    expect(await status(() => authorizePlatform(two.auth, 'platform.read'))).toBe(403);
  });

  it('si un equipo pasa a otro club, el administrador del club anterior deja de verlo', () => {
    const auth: AuthContext = { deviceId: 'd', grants: [], admin: { identityId: 'x', roles: [{ role: 'club_admin', clubId: 'A' }], verifiedAt: NOW } };
    expect(effectiveRole(auth, { id: 'a1', clubId: 'A' })).toBe('club_admin');
    expect(effectiveRole(auth, { id: 'a1', clubId: 'B' })).toBeNull();
  });

  it('al revocar un permiso se pierde el acceso en la siguiente petición', async () => {
    const { token } = await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    db.run('UPDATE grants SET revoked_at = ?', NOW);
    expect(await status(authorize(db, await authenticate(db, token, PEPPER), 'a1', 'team.read'))).toBe(404);
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    db.run("UPDATE admin_roles SET revoked_at = ? WHERE identity_id = 'ca'", NOW);
    expect(await status(authorize(db, await authenticate(db, ca.token, PEPPER), 'a1', 'team.read'))).toBe(404);
  });

  it('un equipo o club eliminado no es accesible (salvo para revisarlo a nivel de plataforma)', async () => {
    const { auth } = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    db.run("UPDATE teams SET deleted_at = ? WHERE id = 'a1'", NOW);
    expect(await status(authorize(db, auth, 'a1', 'team.read'))).toBe(404);
    db.run("UPDATE clubs SET deleted_at = ? WHERE id = 'A'", NOW);
    expect(await status(authorizeClub(db, auth, 'A', 'club.read'))).toBe(404);
  });
});

describe('verificación reciente para operaciones críticas', () => {
  let db: SqliteD1;
  beforeEach(() => {
    db = migratedDb();
    twoClubs(db);
  });

  it('nombrar administradores o gestionar clubes exige haber verificado la llave hace poco', async () => {
    const now = new Date('2026-10-27T12:00:00Z');
    const old = await addAdmin(db, 'sa-old', [{ role: 'superadmin', clubId: null }], { verifiedAt: '2026-10-27T11:00:00.000Z' });
    expect(await status(authorizeClub(db, old.auth, 'A', 'club.admins.manage', now))).toBe('reauth_required');
    expect(await status(() => authorizePlatform(old.auth, 'platform.clubs.manage', now))).toBe('reauth_required');
    // Las operaciones ordinarias no lo exigen.
    expect(await status(authorizeClub(db, old.auth, 'A', 'club.teams.manage', now))).toBe('ok');

    const fresh = await addAdmin(db, 'sa-new', [{ role: 'superadmin', clubId: null }], { verifiedAt: '2026-10-27T11:55:00.000Z' });
    expect(await status(authorizeClub(db, fresh.auth, 'A', 'club.admins.manage', now))).toBe('ok');
  });
});
