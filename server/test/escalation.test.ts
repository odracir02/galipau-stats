// Separación de privilegios: nadie puede obtener un rol mayor que el que le
// corresponde, ni por la API ni manipulando datos de entrada.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildBootstrapSql, enrollmentHash, generateCode } from '../scripts/bootstrap-superadmin.mjs';
import { appointClubAdmin, createClub, createTeam, deleteClub, revokeClubAdmin } from '../src/admin';
import { authenticate, authorize, authorizeClub } from '../src/auth';
import { HttpError } from '../src/errors';
import { createInvite, redeemInvite } from '../src/invites';
import type { TeamRole } from '../src/model';
import { hashSecret } from '../src/secrets';
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
      expect(await errorOf(appointClubAdmin(db, auth, { clubId: 'A', displayName: 'Yo mismo' }, PEPPER))).toBe('404 not_found');
    }
    expect(rows('SELECT * FROM admin_roles')).toEqual([]);
  });

  it('el administrador de club no puede nombrar administradores, crear clubes ni actuar en otro club', async () => {
    const { auth, identityId } = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    expect(await errorOf(appointClubAdmin(db, auth, { clubId: 'A', displayName: 'Otro' }, PEPPER))).toBe('403 forbidden');
    expect(await errorOf(appointClubAdmin(db, auth, { clubId: 'B', identityId, displayName: 'Yo' }, PEPPER))).toBe('404 not_found');
    expect(await errorOf(createClub(db, auth, { name: 'Nuevo' }))).toBe('403 forbidden');
    expect(await errorOf(createTeam(db, auth, { clubId: 'B', name: 'X', code: 'XX99', season: '2026/27' }))).toBe('404 not_found');
    // En su club sí crea equipos.
    expect(await errorOf(createTeam(db, auth, { clubId: 'A', name: 'Cadete', code: 'cf 2627', season: '2026/27', gender: 'female' }))).toBe('ok');
    expect(rows("SELECT code, club_id FROM teams WHERE name = 'Cadete'")).toEqual([{ code: 'CF2627', club_id: 'A' }]);
  });

  it('el superadministrador nombra administradores de club con un código de alta de un solo uso', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    const res = await appointClubAdmin(db, sa.auth, { clubId: 'A', displayName: 'Presidencia club A' }, PEPPER);
    expect(rows(`SELECT role, club_id, granted_by_identity_id FROM admin_roles WHERE identity_id = '${res.identityId}'`)).toEqual([
      { role: 'club_admin', club_id: 'A', granted_by_identity_id: 'sa' },
    ]);
    const enrollment = rows('SELECT code_hash FROM admin_enrollments')[0] as { code_hash: string };
    expect(enrollment.code_hash).toBe(await hashSecret(`enroll:${res.enrollmentCode.replace(/-/g, '')}`, PEPPER));
    expect(JSON.stringify(rows('SELECT * FROM admin_enrollments'))).not.toContain(res.enrollmentCode.replace(/-/g, ''));
    expect(rows('SELECT action, target_id, identity_id FROM admin_audit')).toEqual([
      { action: 'club_admin.appoint', target_id: 'A', identity_id: 'sa' },
    ]);
  });

  it('retirar el rol de administrador de club cierra sus sesiones si no le queda ningún rol', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    await revokeClubAdmin(db, sa.auth, { clubId: 'A', identityId: 'ca' });
    expect(await errorOf(authenticate(db, ca.token, PEPPER))).toBe('401 unauthorized');
  });

  it('crear y eliminar clubes es exclusivo del superadministrador y queda auditado', async () => {
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    const id = await createClub(db, sa.auth, { name: 'Club Nuevo' });
    expect(await errorOf(deleteClub(db, ca.auth, 'A'))).toBe('403 forbidden');
    await deleteClub(db, sa.auth, 'A');
    expect(await errorOf(authorizeClub(db, ca.auth, 'A', 'club.read'))).toBe('404 not_found');
    expect(rows('SELECT action, target_id FROM admin_audit ORDER BY seq')).toEqual([
      { action: 'club.create', target_id: id },
      { action: 'club.delete', target_id: 'A' },
    ]);
  });

  it('la base de datos no admite roles mezclados', () => {
    db.run("INSERT INTO admin_identities (id, display_name, created_at) VALUES ('x', 'X', ?)", NOW);
    const role = (id: string, r: string, club: string | null) => () =>
      db.run('INSERT INTO admin_roles (id, identity_id, role, club_id, created_at) VALUES (?, ?, ?, ?, ?)', id, 'x', r, club, NOW);
    expect(role('r1', 'superadmin', 'A')).toThrow(/CHECK/); // superadmin no pertenece a un club
    expect(role('r2', 'club_admin', null)).toThrow(/CHECK/); // club_admin siempre de un club
    expect(role('r3', 'coach', 'A')).toThrow(/CHECK/);
    expect(role('r4', 'club_admin', 'A')).not.toThrow();
  });
});

describe('las invitaciones nunca conceden roles administrativos', () => {
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

  it('crea la identidad, el rol y un código de alta guardado solo como hash', () => {
    const code = generateCode();
    const sql = buildBootstrapSql({ identityId: 'owner', displayName: 'Propietario', code, pepper: PEPPER, now: new Date(NOW) });
    expect(sql).not.toContain(code.replace(/-/g, ''));
    apply(sql);
    expect(rows("SELECT role, club_id FROM admin_roles WHERE identity_id = 'owner'")).toEqual([{ role: 'superadmin', club_id: null }]);
    expect(rows('SELECT code_hash, expires_at FROM admin_enrollments')).toEqual([
      { code_hash: enrollmentHash(code, PEPPER), expires_at: '2026-10-27T10:30:00.000Z' },
    ]);
  });

  it('el hash del script coincide con el del servidor', async () => {
    const code = generateCode();
    expect(enrollmentHash(code, PEPPER)).toBe(await hashSecret(`enroll:${code.replace(/-/g, '')}`, PEPPER));
  });

  it('si ya existe un superadministrador, no inserta nada (no sirve para apropiarse de la plataforma)', () => {
    apply(buildBootstrapSql({ identityId: 'owner', displayName: 'Propietario', code: generateCode(), pepper: PEPPER }));
    apply(buildBootstrapSql({ identityId: 'intruso', displayName: 'Intruso', code: generateCode(), pepper: PEPPER }));
    expect(rows("SELECT id FROM admin_identities")).toEqual([{ id: 'owner' }]);
    expect(rows("SELECT identity_id FROM admin_roles WHERE role = 'superadmin'")).toEqual([{ identity_id: 'owner' }]);
  });

  it('el nombre visible no permite inyectar SQL', () => {
    apply(buildBootstrapSql({ identityId: 'owner', displayName: "x'); DROP TABLE clubs; --", code: generateCode(), pepper: PEPPER }));
    expect(rows("SELECT display_name FROM admin_identities")).toEqual([{ display_name: "x'); DROP TABLE clubs; --" }]);
    expect(rows('SELECT COUNT(*) AS n FROM clubs')).toEqual([{ n: 2 }]);
  });
});
