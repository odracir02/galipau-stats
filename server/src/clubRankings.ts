// Rankings del club: las clasificaciones positivas de los rankings de equipo,
// calculadas en el servidor con el mismo motor (computeSeasonStats, rankPlayers)
// sobre los equipos que participan en un grupo (club, temporada, género y grupo
// de clasificación). Una persona con fichas en varios equipos suma una sola vez
// (players.person_id); una ficha sin persona participa sola. Nunca por nombre.
//
// El resultado se guarda en club_rankings_cache con una huella: solo se calcula
// de nuevo si cambia algo de lo que depende (acciones, partidos, fichas de esos
// equipos; vínculos, exclusiones o ajustes del club; reglas). Lo guardado solo
// tiene identificadores y cifras: los nombres se leen al responder. Los
// permisos se comprueban en cada petición, haya o no copia.
import type { Id, Match, MatchEvent } from '../../src/domain/types';
import { countsForSeason } from '../../src/services/statsService';
import { computeSeasonStats, emptyCounters, sumCounters, type Counters, type MatchWithEvents } from '../../src/stats/engine';
import { RANKING_LIMIT, RANKING_THRESHOLDS, rankPlayers, rankingById, type RankingCandidate, type RankingId } from '../../src/stats/rankings';
import { authorizeClub } from './auth';
import type { Db } from './db';
import { HttpError, notFound } from './errors';
import { rowsToMatch, rowToEvent, type EventRow, type MatchRow, type SquadRow } from './mapping';
import type { AuthContext, Gender } from './model';

/** Clasificaciones del club: solo las positivas (nunca exclusiones ni pérdidas). */
export const CLUB_RANKINGS: readonly RankingId[] = ['top_scorer', 'sharpshooter', 'wall', 'thief', 'shots'];

/**
 * Versión de las reglas del cálculo de club. Cambiarla invalida todas las copias.
 * Los mínimos, el límite y las clasificaciones entran en la huella por sí solos;
 * esta versión cubre cambios en la forma de agregar o en el motor.
 */
export const CLUB_RULES_VERSION = 'club-v1';

const GENDERS: readonly Gender[] = ['male', 'female', 'mixed'];

export interface GroupKey {
  season: string;
  gender: Gender;
  group: string;
}

/** Grupo pedido en la consulta (400 si no es válido). */
export function groupFromQuery(params: URLSearchParams): GroupKey {
  const season = (params.get('season') ?? '').trim();
  const gender = params.get('gender') as Gender;
  const group = (params.get('group') ?? '').trim();
  if (!season || season.length > 7 || !GENDERS.includes(gender) || !group || group.length > 30) {
    throw new HttpError(400, 'bad_request', 'Temporada, género o grupo no válidos.');
  }
  return { season, gender, group };
}

const groupKey = (g: GroupKey) => `${g.gender}:${g.group}`;

// --- Lo guardado en caché (sin nombres) ------------------------------------------------

interface CachedEntry {
  /** Participante: «p:<persona>» o «f:<ficha>». */
  k: string;
  p: number;
  v: number;
  m?: number;
  o?: number;
}

interface CachedCandidate {
  players: Id[];
  teams: Id[];
  matches: number;
}

interface CachedRankings {
  candidates: Record<string, CachedCandidate>;
  rankings: Record<string, CachedEntry[]>;
}

// --- Grupo y huella ---------------------------------------------------------------------

interface GroupTeam {
  id: Id;
  code: string;
  name: string;
  seq: number;
}

interface GroupState {
  visibility: 'admins' | 'coaches' | 'members';
  version: number;
  teams: GroupTeam[];
}

/** Club activo y equipos que participan en el grupo, con su último cambio. null si el club no existe o no está activo. */
async function groupState(db: Db, clubId: Id, g: GroupKey): Promise<GroupState | null> {
  const [clubRes, teamsRes] = await db.batch([
    db.prepare("SELECT rankings_visibility AS visibility, rankings_version AS version FROM clubs WHERE id = ? AND deleted_at IS NULL AND status = 'active'").bind(clubId),
    db
      .prepare(
        `SELECT t.id, t.code, t.name, COALESCE((SELECT MAX(c.seq) FROM change_log c WHERE c.team_id = t.id), 0) AS seq
           FROM teams t
          WHERE t.club_id = ? AND t.season = ? AND t.gender = ? AND t.ranking_group = ? AND t.club_rankings = 1 AND t.deleted_at IS NULL
          ORDER BY t.id`,
      )
      .bind(clubId, g.season, g.gender, g.group),
  ]);
  const club = (clubRes?.results?.[0] ?? null) as { visibility: GroupState['visibility']; version: number } | null;
  if (!club) return null;
  return { ...club, teams: (teamsRes?.results ?? []) as GroupTeam[] };
}

async function sha256(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Huella de todo lo que cambia el cálculo de un grupo. */
const fingerprint = (state: GroupState, g: GroupKey) =>
  sha256([CLUB_RULES_VERSION, CLUB_RANKINGS, RANKING_THRESHOLDS, RANKING_LIMIT, g, state.version, state.teams.map((t) => [t.id, t.seq])]);

// --- Cálculo ----------------------------------------------------------------------------

interface PlayerRow {
  id: Id;
  team_id: Id;
  person_id: Id | null;
  role: string | null;
  excluded: number;
}

/** Calcula las clasificaciones del grupo con el motor de los rankings de equipo. */
export async function computeGroup(db: Db, teamIds: readonly Id[], season: string): Promise<CachedRankings> {
  if (teamIds.length === 0) return { candidates: {}, rankings: Object.fromEntries(CLUB_RANKINGS.map((id) => [id, []])) };
  const ids = teamIds.map(() => '?').join(', ');
  const [playersRes, matchesRes, squadRes, eventsRes] = await db.batch([
    // Exclusión de la ficha o de su persona.
    db
      .prepare(
        `SELECT p.id, p.team_id, p.person_id, p.role, MAX(p.ranking_excluded, COALESCE(pe.ranking_excluded, 0)) AS excluded
           FROM players p LEFT JOIN people pe ON pe.id = p.person_id
          WHERE p.team_id IN (${ids})`,
      )
      .bind(...teamIds),
    // Solo los partidos vivos de esa temporada, con sus convocatorias y acciones.
    db.prepare(`SELECT * FROM matches WHERE team_id IN (${ids}) AND season = ? AND deleted_at IS NULL`).bind(...teamIds, season),
    db
      .prepare(`SELECT s.* FROM match_squad s JOIN matches m ON m.id = s.match_id WHERE s.team_id IN (${ids}) AND m.season = ? AND m.deleted_at IS NULL`)
      .bind(...teamIds, season),
    db
      .prepare(`SELECT e.* FROM events e JOIN matches m ON m.id = e.match_id WHERE e.team_id IN (${ids}) AND m.season = ? AND m.deleted_at IS NULL`)
      .bind(...teamIds, season),
  ]);
  const players = new Map(((playersRes?.results ?? []) as PlayerRow[]).map((p) => [p.id, p]));
  const squads = new Map<Id, SquadRow[]>();
  for (const s of (squadRes?.results ?? []) as SquadRow[]) squads.set(s.match_id, [...(squads.get(s.match_id) ?? []), s]);
  const events = new Map<Id, MatchEvent[]>();
  for (const e of (eventsRes?.results ?? []) as EventRow[]) {
    const ev = rowToEvent(e);
    events.set(ev.matchId, [...(events.get(ev.matchId) ?? []), ev]);
  }
  // Partidos de cada equipo, con los mismos criterios que la temporada del equipo.
  const byTeam = new Map<Id, MatchWithEvents[]>();
  for (const row of (matchesRes?.results ?? []) as MatchRow[]) {
    const match: Match = rowsToMatch(row, squads.get(row.id) ?? []);
    const evs = events.get(match.id) ?? [];
    if (!countsForSeason(match, evs)) continue;
    byTeam.set(match.teamId, [...(byTeam.get(match.teamId) ?? []), { match, events: evs }]);
  }

  // Participantes: persona (si la ficha está vinculada) o ficha sola.
  const acc = new Map<string, { name: string; number: number; counters: Counters; matches: number; players: Set<Id>; teams: Set<Id> }>();
  for (const teamId of teamIds) {
    const stats = computeSeasonStats(byTeam.get(teamId) ?? []);
    for (const sp of stats.players.values()) {
      const p = players.get(sp.playerId);
      // Sin ficha del equipo, cuerpo técnico o excluida: no participa.
      if (!p || p.team_id !== teamId || (p.role ?? 'player') !== 'player' || p.excluded === 1) continue;
      const key = p.person_id ? `p:${p.person_id}` : `f:${p.id}`;
      const prev = acc.get(key);
      acc.set(key, {
        // El nombre solo ordena los empates; no se guarda.
        name: prev?.name ?? sp.latest.name,
        number: prev ? Math.min(prev.number, sp.latest.number) : sp.latest.number,
        counters: prev ? sumCounters(prev.counters, sp.counters) : sumCounters(emptyCounters(), sp.counters),
        matches: (prev?.matches ?? 0) + sp.matches,
        players: new Set([...(prev?.players ?? []), p.id]),
        teams: new Set([...(prev?.teams ?? []), teamId]),
      });
    }
  }
  const candidates: RankingCandidate[] = [...acc.entries()].map(([key, c]) => ({ playerId: key, name: c.name, number: c.number, matches: c.matches, counters: c.counters }));
  return {
    candidates: Object.fromEntries([...acc.entries()].map(([key, c]) => [key, { players: [...c.players].sort(), teams: [...c.teams].sort(), matches: c.matches }])),
    rankings: Object.fromEntries(
      CLUB_RANKINGS.map((id) => [
        id,
        rankPlayers(rankingById(id), candidates).map((e): CachedEntry => ({ k: e.player.playerId, p: e.position, v: e.value, ...(e.made !== undefined && { m: e.made, o: e.of }) })),
      ]),
    ),
  };
}

/** Clasificaciones del grupo: de la copia si la huella coincide; si no, se calculan y se guardan. */
async function rankingsOf(db: Db, clubId: Id, g: GroupKey, state: GroupState, now: Date): Promise<{ data: CachedRankings; computedAt: string }> {
  const print = await fingerprint(state, g);
  const cached = await db
    .prepare('SELECT fingerprint, payload, computed_at FROM club_rankings_cache WHERE club_id = ? AND season = ? AND group_key = ?')
    .bind(clubId, g.season, groupKey(g))
    .first<{ fingerprint: string; payload: string; computed_at: string }>();
  if (cached && cached.fingerprint === print) return { data: JSON.parse(cached.payload) as CachedRankings, computedAt: cached.computed_at };
  const data = await computeGroup(db, state.teams.map((t) => t.id), g.season);
  const computedAt = now.toISOString();
  await db
    .prepare(
      `INSERT INTO club_rankings_cache (club_id, season, group_key, fingerprint, payload, computed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (club_id, season, group_key) DO UPDATE SET fingerprint = excluded.fingerprint, payload = excluded.payload, computed_at = excluded.computed_at`,
    )
    .bind(clubId, g.season, groupKey(g), print, JSON.stringify(data), computedAt)
    .run();
  return { data, computedAt };
}

// --- Respuesta --------------------------------------------------------------------------

export interface ClubRankingEntry {
  position: number;
  name: string;
  /** Códigos de los equipos del grupo en los que suma. */
  teams: string[];
  matches: number;
  value: number;
  made?: number;
  of?: number;
}

export interface ClubRanking {
  id: RankingId;
  /** Participantes con cifra en esta clasificación (para «N.º de M»). */
  ranked: number;
  entries: ClubRankingEntry[];
  /** Empatados en el último puesto mostrado que no caben. */
  hiddenTies: number;
}

export interface MyClubPosition {
  playerId: Id;
  excluded?: true;
  rankings: { id: RankingId; position: number; ranked: number; value: number; made?: number; of?: number }[];
}

export interface ClubRankingsResponse {
  season: string;
  gender: Gender;
  group: string;
  computedAt: string;
  teams: { code: string; name: string }[];
  rankings: ClubRanking[];
  mine: MyClubPosition[];
}

/** Nombres de los participantes que se muestran: el visible de la persona o el de la ficha. */
async function namesOf(db: Db, keys: readonly string[]): Promise<Map<string, string>> {
  const people = keys.filter((k) => k.startsWith('p:')).map((k) => k.slice(2));
  const cards = keys.filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
  const out = new Map<string, string>();
  const list = (xs: string[]) => xs.map(() => '?').join(', ');
  const [peopleRes, cardsRes] = await db.batch([
    db.prepare(`SELECT id, display_name AS name FROM people WHERE id IN (${list(people) || "''"})`).bind(...people),
    db.prepare(`SELECT id, name FROM players WHERE id IN (${list(cards) || "''"})`).bind(...cards),
  ]);
  for (const r of (peopleRes?.results ?? []) as { id: string; name: string }[]) out.set(`p:${r.id}`, r.name);
  for (const r of (cardsRes?.results ?? []) as { id: string; name: string }[]) out.set(`f:${r.id}`, r.name);
  return out;
}

async function buildResponse(
  db: Db,
  g: GroupKey,
  state: GroupState,
  data: CachedRankings,
  computedAt: string,
  { limit, mine }: { limit: number | null; mine: readonly Id[] },
): Promise<ClubRankingsResponse> {
  const shown = Object.fromEntries(CLUB_RANKINGS.map((id) => [id, limit === null ? data.rankings[id]! : data.rankings[id]!.slice(0, limit)]));
  const names = await namesOf(db, [...new Set(Object.values(shown).flatMap((es) => es.map((e) => e.k)))]);
  const code = new Map(state.teams.map((t) => [t.id, t.code]));
  const rankings = CLUB_RANKINGS.map((id): ClubRanking => {
    const all = data.rankings[id]!;
    const entries = shown[id]!;
    const last = entries.at(-1);
    return {
      id,
      ranked: all.length,
      hiddenTies: last ? all.slice(entries.length).filter((e) => e.p === last.p).length : 0,
      entries: entries.map((e) => ({
        position: e.p,
        name: names.get(e.k) ?? '',
        teams: data.candidates[e.k]!.teams.map((t) => code.get(t) ?? ''),
        matches: data.candidates[e.k]!.matches,
        value: e.v,
        ...(e.m !== undefined && { made: e.m, of: e.o }),
      })),
    };
  });
  return {
    season: g.season,
    gender: g.gender,
    group: g.group,
    computedAt,
    teams: state.teams.map((t) => ({ code: t.code, name: t.name })),
    rankings,
    mine: await positionsOf(db, data, mine),
  };
}

/** Puesto propio de fichas ya autorizadas (también fuera del Top 10), sin datos de nadie más. */
async function positionsOf(db: Db, data: CachedRankings, playerIds: readonly Id[]): Promise<MyClubPosition[]> {
  if (playerIds.length === 0) return [];
  const rows = (
    await db
      .prepare(
        `SELECT p.id, p.person_id, MAX(p.ranking_excluded, COALESCE(pe.ranking_excluded, 0)) AS excluded
           FROM players p LEFT JOIN people pe ON pe.id = p.person_id WHERE p.id IN (${playerIds.map(() => '?').join(', ')})`,
      )
      .bind(...playerIds)
      .all<{ id: string; person_id: string | null; excluded: number }>()
  ).results;
  return rows.map((r): MyClubPosition => {
    if (r.excluded === 1) return { playerId: r.id, excluded: true, rankings: [] };
    const key = r.person_id ? `p:${r.person_id}` : `f:${r.id}`;
    return {
      playerId: r.id,
      rankings: CLUB_RANKINGS.flatMap((id) => {
        const all = data.rankings[id]!;
        const e = all.find((x) => x.k === key);
        return e ? [{ id, position: e.p, ranked: all.length, value: e.v, ...(e.m !== undefined && { made: e.m, of: e.o }) }] : [];
      }),
    };
  });
}

// --- Consulta por dispositivos -------------------------------------------------------------

const unavailable = () => new HttpError(403, 'club_rankings_unavailable', 'Los rankings del club no están disponibles para este dispositivo.');

/**
 * Un dispositivo solo ve los rankings de un grupo si el club los abre a su rol
 * y tiene permiso de entrenador en un equipo que participa en ese grupo. La
 * consulta (familias) no los ve todavía, aunque el club figure como «members».
 */
function deviceAllowed(auth: AuthContext, clubId: Id, state: GroupState): boolean {
  if (state.visibility === 'admins') return false;
  const teams = new Set(state.teams.map((t) => t.id));
  return auth.grants.some((gr) => gr.clubId === clubId && gr.role === 'coach' && teams.has(gr.teamId));
}

/** Top 10 de cada clasificación y el puesto de las fichas propias pedidas (de equipos a los que tiene acceso). */
export async function deviceClubRankings(db: Db, auth: AuthContext, clubId: Id, g: GroupKey, requested: readonly Id[], now = new Date()): Promise<ClubRankingsResponse> {
  // Sin ningún permiso en el club: como si no existiera.
  if (!auth.grants.some((gr) => gr.clubId === clubId)) throw notFound();
  const state = await groupState(db, clubId, g);
  if (!state) throw notFound();
  if (!deviceAllowed(auth, clubId, state)) throw unavailable();
  const own = await ownPlayers(db, auth, clubId, state, requested);
  const { data, computedAt } = await rankingsOf(db, clubId, g, state, now);
  return buildResponse(db, g, state, data, computedAt, { limit: RANKING_LIMIT, mine: own });
}

/**
 * De las fichas pedidas, solo las de equipos del grupo en los que el dispositivo
 * tiene permiso (como mucho 5); las de otros equipos se ignoran.
 *
 * Pedir una ficha NO acredita quién es la persona que usa el dispositivo: no hay
 * identidad de usuario final. Cualquier dispositivo con permiso en un equipo
 * puede pedir el puesto de cualquier ficha de ESE equipo, cuyas estadísticas ya
 * ve en la descarga del equipo. La trayectoria personal entre equipos necesitará
 * una autorización propia (concesión por persona), no este parámetro.
 */
async function ownPlayers(db: Db, auth: AuthContext, clubId: Id, state: GroupState, requested: readonly Id[]): Promise<Id[]> {
  const ids = [...new Set(requested)].slice(0, 5);
  if (ids.length === 0) return [];
  const teams = new Set(state.teams.map((t) => t.id).filter((t) => auth.grants.some((gr) => gr.clubId === clubId && gr.teamId === t)));
  const rows = (
    await db
      .prepare(`SELECT id, team_id FROM players WHERE id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL AND role = 'player'`)
      .bind(...ids)
      .all<{ id: string; team_id: string }>()
  ).results;
  return rows.filter((r) => teams.has(r.team_id)).map((r) => r.id);
}

/**
 * Grupo que el dispositivo puede consultar y, de sus equipos, los de este club
 * en los que el dispositivo es entrenador (para preseleccionar el del equipo abierto).
 */
export interface DeviceClubGroup extends GroupKey {
  teamIds: Id[];
}

/** Grupos que el dispositivo puede consultar (para ofrecerlos en la aplicación). */
export async function deviceClubGroups(db: Db, auth: AuthContext, clubId: Id): Promise<{ groups: DeviceClubGroup[] }> {
  if (!auth.grants.some((gr) => gr.clubId === clubId)) throw notFound();
  const club = await db
    .prepare("SELECT rankings_visibility AS visibility FROM clubs WHERE id = ? AND deleted_at IS NULL AND status = 'active'")
    .bind(clubId)
    .first<{ visibility: GroupState['visibility'] }>();
  if (!club) throw notFound();
  if (club.visibility === 'admins') return { groups: [] };
  const coachTeams = auth.grants.filter((gr) => gr.clubId === clubId && gr.role === 'coach').map((gr) => gr.teamId);
  if (coachTeams.length === 0) return { groups: [] };
  const rows = (
    await db
      .prepare(
        `SELECT season, gender, ranking_group AS "group", id FROM teams
          WHERE club_id = ? AND club_rankings = 1 AND ranking_group IS NOT NULL AND gender IS NOT NULL AND deleted_at IS NULL
            AND id IN (${coachTeams.map(() => '?').join(', ')})
          ORDER BY season DESC, gender, ranking_group, id`,
      )
      .bind(clubId, ...coachTeams)
      .all<GroupKey & { id: Id }>()
  ).results;
  // Mismo orden y mismos grupos que antes; cada uno con sus equipos (solo los del dispositivo).
  const groups = new Map<string, DeviceClubGroup>();
  for (const { id, ...g } of rows) {
    const key = `${g.season}|${groupKey(g)}`;
    const found = groups.get(key);
    if (found) found.teamIds.push(id);
    else groups.set(key, { ...g, teamIds: [id] });
  }
  return { groups: [...groups.values()] };
}

// --- Administración --------------------------------------------------------------------

/** Clasificación completa (todos los puestos), para revisar antes de abrirla. Solo administración. */
export async function adminClubRankings(db: Db, auth: AuthContext, clubId: Id, g: GroupKey, now = new Date()): Promise<ClubRankingsResponse> {
  await authorizeClub(db, auth, clubId, 'club.rankings.manage');
  const state = await groupState(db, clubId, g);
  // Un club suspendido lo revisa el superadministrador: sin cálculo, solo el aviso.
  if (!state) throw new HttpError(409, 'club_inactive', 'El club no está activo.');
  const { data, computedAt } = await rankingsOf(db, clubId, g, state, now);
  return buildResponse(db, g, state, data, computedAt, { limit: null, mine: [] });
}
