import { beforeEach, describe, expect, it } from 'vitest';
import { adminContext, authenticate, authorize, authorizeClub, authorizePlatform, effectiveRole } from '../src/auth';
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
    if (e instanceof HttpError) return e.code === 'unauthorized' || e.code === 'not_found' || e.code === 'forbidden' ? e.status : e.code;
    throw e;
  }
}

const claims = (email: string, sub = 'sub-x', critical = false) => ({ email, sub, iat: 0, exp: 0, critical });

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

describe('autenticación de dispositivos', () => {
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

  it('el token no se guarda en claro', async () => {
    const { token } = await addDevice(db, 'd1', []);
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM device_tokens').all())).not.toContain(token);
  });

  it('un dispositivo de entrenador o consulta nunca tiene roles administrativos', async () => {
    const { auth } = await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect(auth.admin).toBeUndefined();
  });
});

describe('identidad administrativa (tras Cloudflare Access)', () => {
  let db: SqliteD1;
  beforeEach(() => {
    db = migratedDb();
    twoClubs(db);
  });

  it('una cuenta autenticada por Access sin identidad en D1 no es administradora', async () => {
    expect(await status(adminContext(db, claims('cualquiera@example.com')))).toBe('not_admin');
  });

  it('una identidad sin roles vigentes, o desactivada, no es administradora', async () => {
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    db.run("UPDATE admin_roles SET revoked_at = ? WHERE identity_id = 'ca'", NOW);
    expect(await status(adminContext(db, claims(ca.email, 'sub-ca')))).toBe('not_admin');
    db.run("UPDATE admin_roles SET revoked_at = NULL WHERE identity_id = 'ca'");
    db.run("UPDATE admin_identities SET disabled_at = ? WHERE id = 'ca'", NOW);
    expect(await status(adminContext(db, claims(ca.email, 'sub-ca')))).toBe('not_admin');
  });

  it('la primera cuenta de Access que entra queda vinculada; otra con el mismo correo es rechazada', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    expect(db.sqlite.prepare("SELECT access_subject FROM admin_identities WHERE id = 'sa'").get()).toEqual({ access_subject: 'sub-sa' });
    expect(await status(adminContext(db, claims(sa.email, 'otra-cuenta')))).toBe('identity_mismatch');
    expect(await status(adminContext(db, claims(sa.email, 'sub-sa')))).toBe('ok');
  });

  it('el correo se compara en minúsculas y la base de datos exige guardarlo así', async () => {
    const sa = await addAdmin(db, 'SA', [{ role: 'superadmin', clubId: null }]);
    expect(sa.email).toBe('sa@example.com');
    expect(() => db.run("INSERT INTO admin_identities (id, display_name, email, created_at) VALUES ('x', 'X', 'Mayus@Example.com', ?)", NOW)).toThrow(
      /admin_email_invalid/,
    );
    expect(() => db.run("INSERT INTO admin_identities (id, display_name, created_at) VALUES ('y', 'Y', ?)", NOW)).toThrow(/admin_email_invalid/);
  });

  it('los roles se leen en cada petición: retirar un rol tiene efecto inmediato', async () => {
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    expect(await status(authorize(db, ca.auth, 'a1', 'team.manage'))).toBe('ok');
    db.run("UPDATE admin_roles SET revoked_at = ? WHERE identity_id = 'ca'", NOW);
    expect(await status(adminContext(db, claims(ca.email, 'sub-ca')))).toBe('not_admin');
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
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }], { critical: true });
    for (const team of ['a1', 'a2', 'b1']) expect(await status(authorize(db, sa.auth, team, 'grants.manage'))).toBe('ok');
    for (const club of ['A', 'B']) expect(await status(authorizeClub(db, sa.auth, club, 'club.admins.manage'))).toBe('ok');
    expect(await status(() => authorizePlatform(sa.auth, 'platform.clubs.manage'))).toBe('ok');
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
    const auth: AuthContext = {
      deviceId: null,
      grants: [],
      admin: { identityId: 'x', email: 'x@example.com', roles: [{ role: 'club_admin', clubId: 'A' }], critical: false },
    };
    expect(effectiveRole(auth, { id: 'a1', clubId: 'A' })).toBe('club_admin');
    expect(effectiveRole(auth, { id: 'a1', clubId: 'B' })).toBeNull();
  });

  it('al revocar un permiso de dispositivo se pierde el acceso en la siguiente petición', async () => {
    const { token } = await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    db.run('UPDATE grants SET revoked_at = ?', NOW);
    expect(await status(authorize(db, await authenticate(db, token, PEPPER), 'a1', 'team.read'))).toBe(404);
  });

  it('un equipo o club eliminado no es accesible', async () => {
    const { auth } = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    db.run("UPDATE teams SET deleted_at = ? WHERE id = 'a1'", NOW);
    expect(await status(authorize(db, auth, 'a1', 'team.read'))).toBe(404);
    db.run("UPDATE clubs SET deleted_at = ? WHERE id = 'A'", NOW);
    expect(await status(authorizeClub(db, auth, 'A', 'club.read'))).toBe(404);
  });
});

describe('operaciones críticas', () => {
  let db: SqliteD1;
  beforeEach(() => {
    db = migratedDb();
    twoClubs(db);
  });

  it('nombrar administradores o gestionar clubes exige el token de la aplicación crítica', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    expect(await status(authorizeClub(db, sa.auth, 'A', 'club.admins.manage'))).toBe('reauth_required');
    expect(await status(() => authorizePlatform(sa.auth, 'platform.clubs.manage'))).toBe('reauth_required');
    // Las operaciones ordinarias no lo exigen.
    expect(await status(authorizeClub(db, sa.auth, 'A', 'club.teams.manage'))).toBe('ok');
    const fresh = await sa.critical();
    expect(await status(authorizeClub(db, fresh, 'A', 'club.admins.manage'))).toBe('ok');
  });

  it('el token crítico no amplía el rol: un administrador de club sigue sin poder nombrar administradores', async () => {
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }], { critical: true });
    expect(await status(authorizeClub(db, ca.auth, 'A', 'club.admins.manage'))).toBe(403);
    expect(await status(() => authorizePlatform(ca.auth, 'platform.clubs.manage'))).toBe(403);
  });
});
