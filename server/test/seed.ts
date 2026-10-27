// Datos ficticios para las pruebas del servidor. No representan personas reales.
import type { Match, Player } from '../../src/domain/types';
import { makeMatch, SQUAD } from '../../src/test/fixtures';
import { adminContext, authenticate } from '../src/auth';
import { insertSql, matchToRows, playerToRow, teamToRow } from '../src/mapping';
import type { AdminRole, AuthContext } from '../src/model';
import { generateToken, hashSecret } from '../src/secrets';
import type { SqliteD1 } from './sqliteD1';

export const PEPPER = 'clave-de-pruebas-solo-para-tests-0123456789';
export const NOW = '2026-10-27T10:00:00.000Z';

function insert(db: SqliteD1, table: string, row: object): void {
  const { sql, values } = insertSql(table, row);
  db.run(sql, ...values);
}

export function addClub(db: SqliteD1, id: string, name = `Club ${id}`): void {
  db.run('INSERT INTO clubs (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', id, name, NOW, NOW);
}

export function addTeam(db: SqliteD1, id: string, clubId: string, code = id.toUpperCase().padEnd(3, 'X')): void {
  insert(
    db,
    'teams',
    teamToRow(
      { id, name: `Equipo ${id}`, code, season: '2026/27', maxSquad: 16, createdAt: NOW, updatedAt: NOW },
      { clubId, category: 'Senior', gender: 'male' },
    ),
  );
}

/** Plantilla de src/test/fixtures (p7, p14, p69, g1, g12) con ids propios del equipo. */
export function addRoster(db: SqliteD1, teamId: string, prefix = ''): Player[] {
  return SQUAD.map((s) => {
    const p: Player = {
      id: `${prefix}${s.playerId}`,
      teamId,
      name: s.name,
      number: s.number,
      position: s.position,
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    insert(db, 'players', playerToRow(p));
    return p;
  });
}

export function addMatch(db: SqliteD1, teamId: string, overrides: Partial<Match> = {}, prefix = ''): Match {
  const match = makeMatch({
    teamId,
    squad: SQUAD.map((s) => ({ ...s, playerId: `${prefix}${s.playerId}` })),
    ...overrides,
  });
  const rows = matchToRows(match);
  insert(db, 'matches', rows.match);
  for (const s of rows.squad) insert(db, 'match_squad', s);
  return match;
}

/** Dispositivo con token y permisos de equipo; devuelve también su contexto autenticado. */
export async function addDevice(
  db: SqliteD1,
  id: string,
  // Tipos abiertos a propósito: las pruebas de esquema intentan valores no válidos.
  grants: { clubId: string; teamId: string | null; role: string }[],
): Promise<{ deviceId: string; token: string; auth: AuthContext }> {
  const token = generateToken();
  db.run('INSERT INTO devices (id, label, created_at) VALUES (?, ?, ?)', id, `Dispositivo ${id}`, NOW);
  db.run('INSERT INTO device_tokens (token_hash, device_id, created_at) VALUES (?, ?, ?)', await hashSecret(token, PEPPER), id, NOW);
  grants.forEach((g, i) =>
    db.run(
      'INSERT INTO grants (id, device_id, club_id, team_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      `${id}-g${i}`,
      id,
      g.clubId,
      g.teamId,
      g.role,
      NOW,
    ),
  );
  return { deviceId: id, token, auth: await authenticate(db, token, PEPPER) };
}

/** Dos clubes aislados: A con equipos a1 y a2, B con b1. Todos con plantilla. */
export function twoClubs(db: SqliteD1): void {
  addClub(db, 'A');
  addClub(db, 'B');
  addTeam(db, 'a1', 'A', 'SM2627');
  addTeam(db, 'a2', 'A', 'JF2627');
  addTeam(db, 'b1', 'B', 'SM2627');
  addRoster(db, 'a1', 'a1-');
  addRoster(db, 'a2', 'a2-');
  addRoster(db, 'b1', 'b1-');
}

/**
 * Identidad administrativa con roles en D1 y su contexto tal como queda tras
 * validar el JWT de Cloudflare Access. `critical` simula un token de la
 * aplicación de operaciones críticas.
 */
export async function addAdmin(
  db: SqliteD1,
  id: string,
  roles: { role: AdminRole | string; clubId: string | null }[],
  { critical = false } = {},
): Promise<{ identityId: string; email: string; auth: AuthContext; critical: () => Promise<AuthContext> }> {
  const email = `${id.toLowerCase()}@example.com`;
  db.run('INSERT INTO admin_identities (id, display_name, email, created_at) VALUES (?, ?, ?, ?)', id, `Admin ${id}`, email, NOW);
  roles.forEach((r, i) =>
    db.run(
      'INSERT INTO admin_roles (id, identity_id, role, club_id, created_at) VALUES (?, ?, ?, ?, ?)',
      `${id}-r${i}`,
      id,
      r.role,
      r.clubId,
      NOW,
    ),
  );
  const claims = (crit: boolean) => ({ email, sub: `sub-${id}`, iat: 0, exp: 0, critical: crit });
  return {
    identityId: id,
    email,
    auth: await adminContext(db, claims(critical)),
    critical: () => adminContext(db, claims(true)),
  };
}
