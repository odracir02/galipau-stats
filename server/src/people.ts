// Identidad común de jugadores que juegan en varios equipos del club (personas)
// y exclusiones de los rankings del club. Solo administración: superadministrador o
// administrador de ESE club, sin ventana de operaciones críticas, con auditoría.
//
// Vincular es solo una referencia (players.person_id): las fichas, dorsales,
// convocatorias, partidos y acciones de cada equipo no cambian, ni su versión ni
// el registro de cambios, y nada de esto llega a los dispositivos. Nunca se
// vincula por nombre: siempre lo decide un administrador. La base de datos
// (0007) vuelve a imponer cada regla; aquí se comprueban antes para responder
// con un error claro. Los rankings del club no se configuran: reúnen solos a
// todos los equipos del club en cada temporada (clubRankings.ts).
import type { Id } from '../../src/domain/types';
import { newId } from '../../src/domain/ids';
import { authorizeClub } from './auth';
import type { Db, Statement } from './db';
import { HttpError, notFound } from './errors';
import type { AuthContext } from './model';


/** Ficha deportiva tal como la ve la administración (solo datos del equipo). */
export interface CardView {
  playerId: Id;
  teamId: Id;
  teamCode: string;
  teamName: string;
  season: string;
  number: number;
  name: string;
  position: 'field' | 'goalkeeper';
  active: boolean;
  rankingExcluded: boolean;
}

export interface PersonView {
  id: Id;
  displayName: string;
  rankingExcluded: boolean;
  version: number;
  cards: CardView[];
}

export interface ClubPeople {
  people: PersonView[];
  /** Fichas de jugadores (sin cuerpo técnico) aún sin persona. */
  unlinked: CardView[];
  /** Equipos vivos del club (todos forman el ranking de su temporada). */
  rankings: { teams: { teamId: Id; code: string; name: string; season: string; gender: string | null }[] };
}

const conflict = (message: string) => new HttpError(409, 'conflict', message);
const invalid = (message: string) => new HttpError(400, 'invalid', message);

function auditRow(db: Db, auth: AuthContext, action: string, targetType: string, targetId: Id, at: string, guard?: { sql: string; values: (string | number | null)[] }): Statement {
  // Con `guard`, la auditoría solo se escribe si el cambio se aplica (mismo lote).
  const sql = guard
    ? `INSERT INTO admin_audit (identity_id, action, target_type, target_id, at) SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}`
    : 'INSERT INTO admin_audit (identity_id, action, target_type, target_id, at) VALUES (?, ?, ?, ?, ?)';
  return db.prepare(sql).bind(auth.admin?.identityId ?? null, action, targetType, targetId, at, ...(guard?.values ?? []));
}

/** Texto de una línea: sin saltos ni caracteres de control; espacios repetidos, uno. */
function line(value: unknown, max: number, message: string): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(message);
  const v = value.trim().replace(/ {2,}/g, ' ');
  if (!v || v.length > max) throw invalid(message);
  return v;
}

/** Nombre visible: 1–80 caracteres. */
const displayName = (value: unknown): string => line(value, 80, 'Nombre visible no válido.');

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw invalid('Falta la versión esperada.');
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${field} no válido.`);
  return value;
}

/** Traduce un rechazo de la base de datos (0007) a un error claro, sin datos. */
function linkError(e: unknown): never {
  const msg = String((e as Error)?.message ?? e);
  if (/UNIQUE|players_person_per_team/.test(msg)) throw conflict('Esa persona ya tiene una ficha en este equipo.');
  if (/person_link_invalid|person_other_club/.test(msg)) throw conflict('No se puede vincular esta ficha a esa persona.');
  if (/person_still_linked/.test(msg)) throw conflict('La persona tiene fichas vinculadas; vuelve a intentarlo.');
  throw e;
}

// --- Consulta ---------------------------------------------------------------------

interface CardRow {
  player_id: string;
  person_id: string | null;
  team_id: string;
  code: string;
  team_name: string;
  season: string;
  number: number;
  name: string;
  position: 'field' | 'goalkeeper';
  active: number;
  ranking_excluded: number;
}

const card = (r: CardRow): CardView => ({
  playerId: r.player_id,
  teamId: r.team_id,
  teamCode: r.code,
  teamName: r.team_name,
  season: r.season,
  number: r.number,
  name: r.name,
  position: r.position,
  active: r.active === 1,
  rankingExcluded: r.ranking_excluded === 1,
});

/** Personas del club con sus fichas, fichas sin vincular y los equipos del club. */
export async function listClubPeople(db: Db, auth: AuthContext, clubId: Id): Promise<ClubPeople> {
  await authorizeClub(db, auth, clubId, 'club.people.manage');
  const [peopleRes, cardsRes, teamsRes] = await db.batch([
    db
      .prepare('SELECT id, display_name, ranking_excluded, version FROM people WHERE club_id = ? AND deleted_at IS NULL ORDER BY display_name, id')
      .bind(clubId),
    // Fichas de jugadores (nunca cuerpo técnico) de equipos vivos del club.
    db
      .prepare(
        `SELECT p.id AS player_id, p.person_id, p.team_id, t.code, t.name AS team_name, t.season, p.number, p.name, p.position,
                p.active, p.ranking_excluded
           FROM players p JOIN teams t ON t.id = p.team_id
          WHERE t.club_id = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND p.role = 'player'
          ORDER BY t.season DESC, t.code, p.number, p.id`,
      )
      .bind(clubId),
    db
      .prepare(
        `SELECT id, code, name, season, gender FROM teams
          WHERE club_id = ? AND deleted_at IS NULL ORDER BY season DESC, code`,
      )
      .bind(clubId),
  ]);
  const rows = <T>(r: { results?: unknown[] } | undefined) => (r?.results ?? []) as T[];
  const cards = rows<CardRow>(cardsRes);
  return {
    people: rows<{ id: string; display_name: string; ranking_excluded: number; version: number }>(peopleRes).map((p) => ({
      id: p.id,
      displayName: p.display_name,
      rankingExcluded: p.ranking_excluded === 1,
      version: p.version,
      cards: cards.filter((c) => c.person_id === p.id).map(card),
    })),
    unlinked: cards.filter((c) => c.person_id === null).map(card),
    rankings: {
      teams: rows<{ id: string; code: string; name: string; season: string; gender: string | null }>(teamsRes).map((t) => ({
        teamId: t.id,
        code: t.code,
        name: t.name,
        season: t.season,
        gender: t.gender,
      })),
    },
  };
}

// --- Personas -----------------------------------------------------------------------

export async function createPerson(db: Db, auth: AuthContext, clubId: Id, args: { displayName?: unknown }, now = new Date()): Promise<{ personId: Id; version: number }> {
  await authorizeClub(db, auth, clubId, 'club.people.manage');
  const name = displayName(args.displayName);
  const id = newId();
  const at = now.toISOString();
  await db.batch([
    db.prepare('INSERT INTO people (id, club_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, clubId, name, at, at),
    auditRow(db, auth, 'person.create', 'person', id, at),
  ]);
  return { personId: id, version: 1 };
}

/**
 * Crea una persona con dos fichas de equipos distintos del club, todo o nada:
 * en un solo lote, y cada escritura solo si las dos fichas siguen sin persona
 * (si otro administrador vinculó alguna entretanto, no se crea nada: 409). Las
 * fichas no cambian de versión ni pasan por el registro de cambios.
 */
export async function createPersonWithCards(
  db: Db,
  auth: AuthContext,
  clubId: Id,
  args: { displayName?: unknown; playerIds?: unknown },
  now = new Date(),
): Promise<{ personId: Id; version: number }> {
  await authorizeClub(db, auth, clubId, 'club.people.manage');
  const name = displayName(args.displayName);
  const ids = args.playerIds;
  if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((x) => typeof x === 'string' && x) || ids[0] === ids[1]) {
    throw invalid('Hacen falta dos fichas distintas.');
  }
  const [a, b] = ids as [Id, Id];
  const rows = (
    await db
      .prepare(
        `SELECT p.id, p.team_id, t.club_id, p.person_id, p.role FROM players p JOIN teams t ON t.id = p.team_id
          WHERE p.id IN (?, ?) AND p.deleted_at IS NULL AND t.deleted_at IS NULL`,
      )
      .bind(a, b)
      .all<{ id: string; team_id: string; club_id: string; person_id: string | null; role: string | null }>()
  ).results;
  // Ficha inexistente, borrada o de otro club: «no encontrada» (no se revela nada de otros clubes).
  if (rows.length !== 2 || rows.some((r) => r.club_id !== clubId)) throw notFound();
  if (rows.some((r) => (r.role ?? 'player') !== 'player')) throw conflict('El cuerpo técnico no se vincula a personas.');
  if (rows[0]!.team_id === rows[1]!.team_id) throw conflict('Las dos fichas son del mismo equipo: no pueden ser de la misma persona.');
  if (rows.some((r) => r.person_id !== null)) throw conflict('Alguna ficha ya tiene persona; vuelve a cargar la lista.');

  const id = newId();
  const at = now.toISOString();
  // Las dos fichas siguen libres, vivas y de jugador: condición de la creación.
  const free = `(SELECT COUNT(*) FROM players WHERE id IN (?, ?) AND person_id IS NULL AND deleted_at IS NULL AND role = 'player') = 2`;
  // Lo demás, solo si la persona se ha creado en este lote.
  const created = { sql: 'EXISTS (SELECT 1 FROM people WHERE id = ?)', values: [id] };
  let results;
  try {
    results = await db.batch([
      db
        .prepare(`INSERT INTO people (id, club_id, display_name, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${free}`)
        .bind(id, clubId, name, at, at, a, b),
      auditRow(db, auth, 'person.create', 'person', id, at, created),
      ...[a, b].flatMap((pid) => [
        auditRow(db, auth, 'person.link', 'player', pid, at, created),
        auditRow(db, auth, 'person.link', 'person', id, at, created),
        db.prepare(`UPDATE players SET person_id = ? WHERE id = ? AND person_id IS NULL AND ${created.sql}`).bind(id, pid, id),
      ]),
    ]);
  } catch (e) {
    // Un trigger o el índice único de 0007 lo rechaza: el lote entero se anula.
    linkError(e);
  }
  if (results[0]!.meta.changes !== 1) throw conflict('Alguna ficha ha cambiado mientras tanto; vuelve a cargar la lista.');
  return { personId: id, version: 1 };
}

/** Persona viva y su club (404 si no existe, está borrada o es de otro club). */
async function personOf(db: Db, auth: AuthContext, personId: Id): Promise<{ id: Id; clubId: Id; version: number; rankingExcluded: boolean }> {
  const row = await db
    .prepare('SELECT id, club_id, version, ranking_excluded FROM people WHERE id = ? AND deleted_at IS NULL')
    .bind(personId)
    .first<{ id: string; club_id: string; version: number; ranking_excluded: number }>();
  if (!row) throw notFound();
  await authorizeClub(db, auth, row.club_id, 'club.people.manage');
  return { id: row.id, clubId: row.club_id, version: row.version, rankingExcluded: row.ranking_excluded === 1 };
}

/**
 * Cambia el nombre visible o la exclusión de los rankings del club, con la
 * versión esperada (si otro administrador la cambió entretanto: 409).
 */
export async function updatePerson(
  db: Db,
  auth: AuthContext,
  personId: Id,
  args: { displayName?: unknown; rankingExcluded?: unknown; expectedVersion?: unknown },
  now = new Date(),
): Promise<{ version: number }> {
  const expected = version(args.expectedVersion);
  const person = await personOf(db, auth, personId);
  const name = args.displayName === undefined ? null : displayName(args.displayName);
  const excluded = args.rankingExcluded === undefined ? null : flag(args.rankingExcluded, 'Exclusión');
  if (name === null && excluded === null) throw invalid('No hay nada que cambiar.');
  const at = now.toISOString();
  const guard = { sql: 'EXISTS (SELECT 1 FROM people WHERE id = ? AND version = ? AND deleted_at IS NULL)', values: [personId, expected] };
  const actions: Statement[] = [];
  if (name !== null) actions.push(auditRow(db, auth, 'person.update', 'person', personId, at, guard));
  if (excluded !== null && excluded !== person.rankingExcluded) {
    actions.push(auditRow(db, auth, excluded ? 'person.ranking_exclude' : 'person.ranking_include', 'person', personId, at, guard));
  }
  const results = await db.batch([
    ...actions,
    db
      .prepare(
        `UPDATE people SET display_name = COALESCE(?, display_name), ranking_excluded = COALESCE(?, ranking_excluded),
           updated_at = ?, version = version + 1
         WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      )
      .bind(name, excluded === null ? null : excluded ? 1 : 0, at, personId, expected),
  ]);
  if (results.at(-1)!.meta.changes !== 1) throw conflict('La persona ha cambiado mientras tanto; vuelve a cargarla.');
  return { version: expected + 1 };
}

/**
 * Borrado lógico: primero desvincula todas sus fichas y después la marca como
 * borrada, en el mismo lote. Las fichas y sus estadísticas no cambian.
 */
export async function deletePerson(db: Db, auth: AuthContext, personId: Id, args: { expectedVersion?: unknown }, now = new Date()): Promise<{ unlinked: number }> {
  const expected = version(args.expectedVersion);
  await personOf(db, auth, personId);
  const linked = (await db.prepare('SELECT id FROM players WHERE person_id = ?').bind(personId).all<{ id: string }>()).results;
  const at = now.toISOString();
  const guard = { sql: 'EXISTS (SELECT 1 FROM people WHERE id = ? AND version = ? AND deleted_at IS NULL)', values: [personId, expected] };
  let results;
  try {
    results = await db.batch([
      ...linked.map((p) => auditRow(db, auth, 'person.unlink', 'player', p.id, at, guard)),
      auditRow(db, auth, 'person.delete', 'person', personId, at, guard),
      db
        .prepare(`UPDATE players SET person_id = NULL WHERE person_id = ? AND ${guard.sql}`)
        .bind(personId, ...guard.values),
      // Si entretanto se vinculó otra ficha, el trigger lo impide y no cambia nada.
      db
        .prepare('UPDATE people SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND deleted_at IS NULL')
        .bind(at, at, personId, expected),
    ]);
  } catch (e) {
    linkError(e);
  }
  if (results.at(-1)!.meta.changes !== 1) throw conflict('La persona ha cambiado mientras tanto; vuelve a cargarla.');
  return { unlinked: results.at(-2)!.meta.changes };
}

// --- Fichas -------------------------------------------------------------------------

interface PlayerRef {
  id: Id;
  teamId: Id;
  clubId: Id;
  personId: Id | null;
  role: string;
  rankingExcluded: boolean;
}

/** Ficha viva de un equipo vivo, y autorización sobre su club (404 si no). */
async function playerOf(db: Db, auth: AuthContext, playerId: Id): Promise<PlayerRef> {
  const row = await db
    .prepare(
      `SELECT p.id, p.team_id, t.club_id, p.person_id, p.role, p.ranking_excluded
         FROM players p JOIN teams t ON t.id = p.team_id
        WHERE p.id = ? AND p.deleted_at IS NULL AND t.deleted_at IS NULL`,
    )
    .bind(playerId)
    .first<{ id: string; team_id: string; club_id: string; person_id: string | null; role: string | null; ranking_excluded: number }>();
  if (!row) throw notFound();
  await authorizeClub(db, auth, row.club_id, 'club.people.manage');
  return { id: row.id, teamId: row.team_id, clubId: row.club_id, personId: row.person_id, role: row.role ?? 'player', rankingExcluded: row.ranking_excluded === 1 };
}

/** «No hay vínculo» es null; cualquier otra cosa, el identificador esperado. */
function expectedPerson(value: unknown): Id | null {
  if (value === null) return null;
  if (typeof value === 'string' && value) return value;
  throw invalid('Falta la persona vinculada esperada (o null).');
}

/**
 * Vincula una ficha a una persona del mismo club. `expectedPersonId`: la
 * persona que tenía (null si ninguna); si otro administrador la cambió, 409.
 */
export async function linkPlayer(
  db: Db,
  auth: AuthContext,
  playerId: Id,
  args: { personId?: unknown; expectedPersonId?: unknown },
  now = new Date(),
): Promise<void> {
  if (typeof args.personId !== 'string' || !args.personId) throw invalid('Falta la persona.');
  const expected = expectedPerson(args.expectedPersonId);
  const player = await playerOf(db, auth, playerId);
  if (player.role !== 'player') throw conflict('El cuerpo técnico no se vincula a personas.');
  // Persona viva del MISMO club (si no, «no encontrada»: no se revela otro club).
  const person = await db
    .prepare('SELECT id FROM people WHERE id = ? AND club_id = ? AND deleted_at IS NULL')
    .bind(args.personId, player.clubId)
    .first<{ id: string }>();
  if (!person) throw notFound();
  if (player.personId === person.id && expected === person.id) return;
  const taken = await db
    .prepare('SELECT 1 AS x FROM players WHERE person_id = ? AND team_id = ? AND id <> ?')
    .bind(person.id, player.teamId, playerId)
    .first();
  if (taken) throw conflict('Esa persona ya tiene una ficha en este equipo.');
  const at = now.toISOString();
  const guard = { sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND person_id IS ?)', values: [playerId, expected] };
  let results;
  try {
    results = await db.batch([
      ...(expected ? [auditRow(db, auth, 'person.unlink', 'player', playerId, at, guard)] : []),
      auditRow(db, auth, 'person.link', 'player', playerId, at, guard),
      auditRow(db, auth, 'person.link', 'person', person.id, at, guard),
      db.prepare('UPDATE players SET person_id = ? WHERE id = ? AND person_id IS ?').bind(person.id, playerId, expected),
    ]);
  } catch (e) {
    linkError(e);
  }
  if (results.at(-1)!.meta.changes !== 1) throw conflict('La ficha ha cambiado mientras tanto; vuelve a cargarla.');
}

/** Desvincula una ficha. Sus acciones, partidos y estadísticas no cambian. */
export async function unlinkPlayer(db: Db, auth: AuthContext, playerId: Id, args: { expectedPersonId?: unknown }, now = new Date()): Promise<void> {
  const expected = expectedPerson(args.expectedPersonId);
  if (expected === null) throw invalid('Falta la persona vinculada esperada.');
  await playerOf(db, auth, playerId);
  const at = now.toISOString();
  const guard = { sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND person_id = ?)', values: [playerId, expected] };
  const results = await db.batch([
    auditRow(db, auth, 'person.unlink', 'player', playerId, at, guard),
    auditRow(db, auth, 'person.unlink', 'person', expected, at, guard),
    db.prepare('UPDATE players SET person_id = NULL WHERE id = ? AND person_id = ?').bind(playerId, expected),
  ]);
  if (results.at(-1)!.meta.changes !== 1) throw conflict('La ficha ha cambiado mientras tanto; vuelve a cargarla.');
}

/** Excluye (o vuelve a incluir) una ficha de los rankings del club. Sigue contando en su equipo. */
export async function setPlayerRankingExcluded(db: Db, auth: AuthContext, playerId: Id, args: { excluded?: unknown }, now = new Date()): Promise<void> {
  const excluded = flag(args.excluded, 'Exclusión');
  const player = await playerOf(db, auth, playerId);
  if (player.role !== 'player') throw conflict('El cuerpo técnico no participa en los rankings.');
  if (player.rankingExcluded === excluded) return;
  const at = now.toISOString();
  const guard = { sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND ranking_excluded = ?)', values: [playerId, excluded ? 0 : 1] };
  await db.batch([
    auditRow(db, auth, excluded ? 'player.ranking_exclude' : 'player.ranking_include', 'player', playerId, at, guard),
    db.prepare('UPDATE players SET ranking_excluded = ? WHERE id = ? AND ranking_excluded = ?').bind(excluded ? 1 : 0, playerId, excluded ? 0 : 1),
  ]);
}
