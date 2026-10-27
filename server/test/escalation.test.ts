// Separación de privilegios: nadie puede obtener un rol mayor que el que le
// corresponde, ni por la API ni manipulando datos de entrada.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { appointClubAdmin, createClub, createTeam, deleteClub, revokeClubAdmin } from '../src/admin';
import { adminContext, authenticate, authorize, authorizeClub } from '../src/auth';
import { HttpError } from '../src/errors';
import { createInvite, redeemInvite } from '../src/invites';
import type { TeamRole } from '../src/model';
import { addAdmin, addDevice, NOW, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let n = 0;
const client = () => `198.51.100.${++n}`;

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof HttpError) return `${e.status} ${e.code}`;
    throw e;
  }
}

const rows = (sql: string) => db.sqlite.prepare(sql).all();

beforeEach(() => {
  db = migratedDb();
  twoClubs(db);
});

describe('roles administrativos', () => {
  it('ni entrenador ni consulta pueden crear clubes, equipos o administradores', async () => {
    for (const role of ['coach', 'viewer']) {
      const { auth } = await addDevice(db, `d-${role}`, [{ clubId: 'A', teamId: 'a1', role }]);
      expect(await errorOf(createClub(db, auth, { name: 'Club pirata' }))).toBe('403 forbidden');
      expect(await errorOf(createTeam(db, auth, { clubId: 'A', name: 'X', code: 'XX99', season: '2026/27' }))).toBe('404 not_found');
      expect(await errorOf(appointClubAdmin(db, auth, { clubId: 'A', email: 'yo@example.com' }))).toBe('404 not_found');
    }
    expect(rows('SELECT * FROM admin_roles')).toEqual([]);
  });

  it('el administrador de club no puede nombrar administradores, crear clubes ni actuar en otro club', async () => {
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }], { critical: true });
    expect(await errorOf(appointClubAdmin(db, ca.auth, { clubId: 'A', email: 'otro@example.com' }))).toBe('403 forbidden');
    expect(await errorOf(appointClubAdmin(db, ca.auth, { clubId: 'B', email: ca.email }))).toBe('404 not_found');
    expect(await errorOf(createClub(db, ca.auth, { name: 'Nuevo' }))).toBe('403 forbidden');
    expect(await errorOf(createTeam(db, ca.auth, { clubId: 'B', name: 'X', code: 'XX99', season: '2026/27' }))).toBe('404 not_found');
    // En su club sí crea equipos.
    expect(await errorOf(createTeam(db, ca.auth, { clubId: 'A', name: 'Cadete', code: 'cf 2627', season: '2026/27', gender: 'female' }))).toBe('ok');
    expect(rows("SELECT code, club_id FROM teams WHERE name = 'Cadete'")).toEqual([{ code: 'CF2627', club_id: 'A' }]);
  });

  it('el superadministrador nombra administradores de club por correo, con auditoría', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }], { critical: true });
    const res = await appointClubAdmin(db, sa.auth, { clubId: 'A', email: '  Presidencia@ClubA.example ', displayName: 'Presidencia' });
    expect(rows(`SELECT email FROM admin_identities WHERE id = '${res.identityId}'`)).toEqual([{ email: 'presidencia@cluba.example' }]);
    expect(rows(`SELECT role, club_id, granted_by_identity_id FROM admin_roles WHERE identity_id = '${res.identityId}'`)).toEqual([
      { role: 'club_admin', club_id: 'A', granted_by_identity_id: 'sa' },
    ]);
    expect(rows('SELECT action, target_id, identity_id FROM admin_audit')).toEqual([{ action: 'club_admin.appoint', target_id: 'A', identity_id: 'sa' }]);
    // La nueva persona entra con Access y solo administra su club.
    const auth = await adminContext(db, { email: 'presidencia@cluba.example', sub: 'sub-p', iat: 0, exp: 0, critical: false });
    expect(await errorOf(authorize(db, auth, 'a1', 'team.manage'))).toBe('ok');
    expect(await errorOf(authorize(db, auth, 'b1', 'team.read'))).toBe('404 not_found');
    // No se duplica ni acepta correos no válidos.
    expect(await errorOf(appointClubAdmin(db, sa.auth, { clubId: 'A', email: 'presidencia@cluba.example' }))).toBe('409 already_admin');
    expect(await errorOf(appointClubAdmin(db, sa.auth, { clubId: 'A', email: 'no-es-correo' }))).toBe('400 invalid_email');
  });

  it('una misma persona puede administrar dos clubes; retirar uno no afecta al otro', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }], { critical: true });
    const { identityId } = await appointClubAdmin(db, sa.auth, { clubId: 'A', email: 'p@example.com' });
    await appointClubAdmin(db, sa.auth, { clubId: 'B', email: 'p@example.com' });
    await revokeClubAdmin(db, sa.auth, { clubId: 'A', identityId });
    const auth = await adminContext(db, { email: 'p@example.com', sub: 'sub-p', iat: 0, exp: 0, critical: false });
    expect(await errorOf(authorize(db, auth, 'a1', 'team.read'))).toBe('404 not_found');
    expect(await errorOf(authorize(db, auth, 'b1', 'team.manage'))).toBe('ok');
    expect(await errorOf(revokeClubAdmin(db, sa.auth, { clubId: 'A', identityId }))).toBe('404 not_found');
  });

  it('crear y eliminar clubes es exclusivo del superadministrador y queda auditado', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }], { critical: true });
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }], { critical: true });
    const id = await createClub(db, sa.auth, { name: 'Club Nuevo' });
    expect(await errorOf(deleteClub(db, ca.auth, 'A'))).toBe('403 forbidden');
    await deleteClub(db, sa.auth, 'A');
    expect(await errorOf(authorizeClub(db, ca.auth, 'A', 'club.read'))).toBe('404 not_found');
    expect(await errorOf(deleteClub(db, sa.auth, 'A'))).toBe('404 not_found');
    expect(rows('SELECT action, target_id FROM admin_audit ORDER BY seq')).toEqual([
      { action: 'club.create', target_id: id },
      { action: 'club.delete', target_id: 'A' },
    ]);
  });

  it('la base de datos no admite roles mezclados', () => {
    db.run("INSERT INTO admin_identities (id, display_name, email, created_at) VALUES ('x', 'X', 'x@example.com', ?)", NOW);
    const role = (id: string, r: string, club: string | null) => () =>
      db.run('INSERT INTO admin_roles (id, identity_id, role, club_id, created_at) VALUES (?, ?, ?, ?, ?)', id, 'x', r, club, NOW);
    expect(role('r1', 'superadmin', 'A')).toThrow(/CHECK/); // superadmin no pertenece a un club
    expect(role('r2', 'club_admin', null)).toThrow(/CHECK/); // club_admin siempre de un club
    expect(role('r3', 'coach', 'A')).toThrow(/CHECK/);
    expect(role('r4', 'club_admin', 'A')).not.toThrow();
  });
});

describe('las credenciales de dispositivo y las invitaciones nunca dan roles administrativos', () => {
  it('rechaza crear invitaciones con un rol administrativo, aunque se fuerce el tipo', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    for (const role of ['club_admin', 'superadmin', 'admin']) {
      expect(await errorOf(createInvite(db, sa.auth, { teamId: 'a1', role: role as TeamRole }, PEPPER))).toBe('400 invalid_role');
    }
    expect(rows('SELECT * FROM invites')).toEqual([]);
  });

  it('ni una invitación ni un permiso manipulados en la base de datos pueden llevar un rol administrativo', async () => {
    const ins = (role: string) => () =>
      db.run(
        "INSERT INTO invites (id, club_id, team_id, role, code_hash, created_at, expires_at) VALUES (?, 'A', 'a1', ?, ?, ?, '2099-01-01')",
        `i-${role}`,
        role,
        `h-${role}`,
        NOW,
      );
    expect(ins('club_admin')).toThrow(/CHECK/);
    expect(ins('superadmin')).toThrow(/CHECK/);
    await expect(addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'club_admin' }])).rejects.toThrow(/CHECK/);
    await expect(addDevice(db, 'd2', [{ clubId: 'A', teamId: 'a1', role: 'superadmin' }])).rejects.toThrow(/CHECK/);
    await expect(addDevice(db, 'd3', [{ clubId: 'A', teamId: null, role: 'coach' }])).rejects.toThrow(/NOT NULL/);
  });

  it('canjear códigos de entrenador y de consulta no da acceso administrativo ni al club', async () => {
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    const coach = await createInvite(db, ca.auth, { teamId: 'a1', role: 'coach' }, PEPPER);
    const viewer = await createInvite(db, ca.auth, { teamId: 'a2', role: 'viewer' }, PEPPER);
    const r = await redeemInvite(db, { code: coach.code, clientKey: client() }, PEPPER);
    let auth = await authenticate(db, r.token, PEPPER);
    await redeemInvite(db, { code: viewer.code, clientKey: client(), auth }, PEPPER);
    auth = await authenticate(db, r.token, PEPPER);
    expect(auth.admin).toBeUndefined();
    expect(await errorOf(authorizeClub(db, auth, 'A', 'club.read'))).toBe('404 not_found');
    expect(await errorOf(authorize(db, auth, 'a1', 'invites.manage'))).toBe('403 forbidden');
    expect(await errorOf(authorize(db, auth, 'a2', 'match.write'))).toBe('403 forbidden');
    expect(rows('SELECT * FROM admin_roles')).toHaveLength(1); // solo el de «ca»
  });

  it('una sesión de administración no sirve para registrar acciones ni canjear códigos como dispositivo', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    const inv = await createInvite(db, sa.auth, { teamId: 'a1', role: 'viewer' }, PEPPER);
    expect(await errorOf(redeemInvite(db, { code: inv.code, clientKey: client(), auth: sa.auth }, PEPPER))).toBe('400 device_required');
  });
});

describe('ninguna operación del servidor concede superadministrador', () => {
  it('no hay código en server/src que inserte el rol superadmin', () => {
    const dir = new URL('../src/', import.meta.url);
    let checked = 0;
    for (const file of readdirSync(dir)) {
      const src = readFileSync(new URL(file, dir), 'utf8');
      // Cada sentencia que inserta roles, hasta el final de su cadena.
      for (const sql of src.match(/INSERT INTO admin_roles[^"`]*/g) ?? []) {
        checked++;
        expect(sql, file).not.toMatch(/superadmin/);
        expect(sql, file).toMatch(/'club_admin'/);
      }
    }
    // La revisión no es vacía: existe al menos la de appointClubAdmin.
    expect(checked).toBeGreaterThan(0);
  });
});

describe('alta del primer superadministrador', () => {
  const apply = (sql: string) => db.sqlite.exec(sql);

  it('crea la identidad (por correo) y el rol, sin secretos en el SQL', async () => {
    const sql = buildBootstrapSql({ identityId: 'owner', email: ' Propietario@Example.com ', displayName: 'Propietario', now: new Date(NOW) });
    apply(sql);
    expect(rows("SELECT email, access_subject FROM admin_identities WHERE id = 'owner'")).toEqual([{ email: 'propietario@example.com', access_subject: null }]);
    expect(rows("SELECT role, club_id FROM admin_roles WHERE identity_id = 'owner'")).toEqual([{ role: 'superadmin', club_id: null }]);
    expect(rows('SELECT action FROM admin_audit')).toEqual([{ action: 'superadmin.bootstrap' }]);
    // Entra con Access y su primera cuenta queda vinculada.
    const auth = await adminContext(db, { email: 'propietario@example.com', sub: 'sub-owner', iat: 0, exp: 0, critical: true });
    expect(await errorOf(authorizeClub(db, auth, 'B', 'club.admins.manage'))).toBe('ok');
  });

  it('si ya existe un superadministrador, no inserta nada (no sirve para apropiarse de la plataforma)', () => {
    apply(buildBootstrapSql({ identityId: 'owner', email: 'owner@example.com' }));
    apply(buildBootstrapSql({ identityId: 'intruso', email: 'intruso@example.com' }));
    expect(rows('SELECT id FROM admin_identities')).toEqual([{ id: 'owner' }]);
    expect(rows("SELECT identity_id FROM admin_roles WHERE role = 'superadmin'")).toEqual([{ identity_id: 'owner' }]);
  });

  it('rechaza correos no válidos y no permite inyectar SQL', () => {
    expect(() => buildBootstrapSql({ identityId: 'x', email: 'sin-arroba' })).toThrow(/Correo/);
    apply(buildBootstrapSql({ identityId: 'owner', email: 'o@example.com', displayName: "x'); DROP TABLE clubs; --" }));
    expect(rows('SELECT display_name FROM admin_identities')).toEqual([{ display_name: "x'); DROP TABLE clubs; --" }]);
    expect(rows('SELECT COUNT(*) AS n FROM clubs')).toEqual([{ n: 2 }]);
  });
});
