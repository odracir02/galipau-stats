// Plan de subida de un equipo local vinculado: qué se enviará, en qué orden y si
// cumple las reglas del servidor. Solo LEE los datos locales: los registros que
// se envían son copias con el identificador del equipo del club; los originales
// no cambian.
import type { LocalSnapshot } from '../data/repository';
import { describePayload } from '../domain/catalog';
import { isPending } from '../domain/events';
import { formatClock, formatDate } from '../domain/format';
import type { Match, MatchEvent, Player, Team } from '../domain/types';
import { assertValidEvent, assertValidPlayerFields, ValidationError } from '../domain/validation';
import type { TeamLink } from './store';

export interface UploadPlan {
  localTeam: Team;
  link: TeamLink;
  /** En orden de envío: jugadores → partidos (con convocatoria) → acciones. */
  players: Player[];
  matches: Match[];
  events: MatchEvent[];
  /**
   * Partidos eliminados en el dispositivo que nunca se enviaron: no se envían
   * (el servidor no admite sus acciones). Los que ya estaban en el servidor
   * sí se envían, solo con su marca de borrado, para que el club deje de verlos.
   */
  skippedMatches: Match[];
  summary: PlanSummary;
  /** Incumplimientos de las reglas del servidor. Con alguno, no se ofrece enviar. */
  problems: string[];
}

export interface PlanSummary {
  players: number;
  inactivePlayers: number;
  matches: number;
  /** Convocados en total (una convocatoria por partido). */
  squadEntries: number;
  events: number;
  deletedEvents: number;
  pendingEvents: number;
  freeThrows: number;
  additionalSanctions: number;
  scoreCorrections: number;
  /** Partidos ya enviados que se han eliminado en el dispositivo: se envía su borrado. */
  matchDeletions: number;
  skippedMatches: number;
  skippedEvents: number;
}

const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Copia del jugador para el servidor: mismo id, equipo del club. */
export const toRemotePlayer = (p: Player, remoteTeamId: string): Player => ({ ...p, teamId: remoteTeamId });

/** Copia del partido para el servidor: mismo id, equipo del club. */
export const toRemoteMatch = (m: Match, remoteTeamId: string): Match => ({ ...m, teamId: remoteTeamId });

const matchLabel = (m: Match) => `vs ${m.opponent} (${formatDate(m.date)})`;

/** Las mismas reglas que aplica el servidor a un partido (server/src/teamsync.ts). */
function matchProblems(m: Match, playerIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const at = matchLabel(m);
  if (!m.opponent?.trim()) out.push(`${at}: falta el equipo contrario.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) out.push(`${at}: fecha no válida.`);
  if (m.venue !== 'home' && m.venue !== 'away') out.push(`${at}: campo no válido.`);
  if (!m.season?.trim()) out.push(`${at}: falta la temporada.`);
  if (!['ready', 'in_progress', 'halftime', 'finished'].includes(m.status)) out.push(`${at}: estado no válido.`);
  if (!isInt(m.halfMinutes, 5, 60)) out.push(`${at}: duración de parte no válida.`);
  if (!isInt(m.scoreAdjustment?.own, -999, 999) || !isInt(m.scoreAdjustment?.opponent, -999, 999)) {
    out.push(`${at}: corrección de marcador no válida.`);
  }
  if (!isIso(m.createdAt) || !isIso(m.updatedAt) || !(m.finishedAt === null || isIso(m.finishedAt))) {
    out.push(`${at}: fechas internas no válidas.`);
  }
  const c = m.clock;
  if (
    !c ||
    (c.period !== 1 && c.period !== 2) ||
    typeof c.running !== 'boolean' ||
    !isInt(c.baseMs, 0) ||
    !(c.anchorWallMs === null || isInt(c.anchorWallMs, 0)) ||
    !(c.firstHalfEndMs === undefined || isInt(c.firstHalfEndMs, 0))
  ) {
    out.push(`${at}: cronómetro no válido.`);
  }
  if (!m.squad?.length) out.push(`${at}: convocatoria vacía.`);
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const s of m.squad ?? []) {
    if (!playerIds.has(s.playerId)) out.push(`${at}: el convocado ${s.number} · ${s.name} no está en la plantilla.`);
    if (!s.name?.trim() || !isInt(s.number, 0, 99) || (s.position !== 'field' && s.position !== 'goalkeeper')) {
      out.push(`${at}: convocado ${s.number} no válido.`);
    }
    if (ids.has(s.playerId) || numbers.has(s.number)) out.push(`${at}: convocado o dorsal repetido (${s.number}).`);
    ids.add(s.playerId);
    numbers.add(s.number);
  }
  return out;
}

/** Las mismas reglas que aplica el servidor a una acción (validación compartida + marca adicional). */
function eventProblems(e: MatchEvent, match: Match): string[] {
  const at = `${matchLabel(match)}, ${describePayload(e)} en ${formatClock(e.matchTimeMs)}`;
  const out: string[] = [];
  try {
    assertValidEvent(match, e);
  } catch (err) {
    if (err instanceof ValidationError) out.push(`${at}: ${err.message}`);
    else throw err;
  }
  if (e.addsToPrevious && ((e.kind !== 'exclusion' && e.kind !== 'red') || e.playerId === null)) {
    out.push(`${at}: marca de sanción adicional no válida.`);
  }
  if (!isIso(e.createdAt) || !isIso(e.updatedAt) || !(e.deletedAt === null || isIso(e.deletedAt))) {
    out.push(`${at}: fechas internas no válidas.`);
  }
  return out;
}

/**
 * Prepara el envío de un equipo local vinculado. No modifica nada: trabaja
 * sobre una lectura completa de la base local.
 */
export function buildPlan(
  local: LocalSnapshot,
  localTeam: Team,
  link: TeamLink,
  /** Partidos que el servidor ya tiene (confirmados en envíos anteriores). */
  sentMatchIds: ReadonlySet<string> = new Set(),
): UploadPlan {
  const players = local.players.filter((p) => p.teamId === localTeam.id).sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  const teamMatches = local.matches.filter((m) => m.teamId === localTeam.id);
  const live = teamMatches.filter((m) => m.deletedAt === null);
  const deletions = teamMatches.filter((m) => m.deletedAt !== null && sentMatchIds.has(m.id));
  const matches = [...live, ...deletions].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const skippedMatches = teamMatches.filter((m) => m.deletedAt !== null && !sentMatchIds.has(m.id));
  // Las acciones solo de los partidos vigentes: las de un partido eliminado ya no se envían.
  const included = new Map(live.map((m) => [m.id, m]));
  const skippedIds = new Set(skippedMatches.map((m) => m.id));
  const events = local.events
    .filter((e) => included.has(e.matchId))
    .sort((a, b) => a.matchId.localeCompare(b.matchId) || a.period - b.period || a.matchTimeMs - b.matchTimeMs || a.createdAt.localeCompare(b.createdAt));

  const problems: string[] = [];
  const active = new Map<number, Player>();
  for (const p of players) {
    try {
      assertValidPlayerFields(p);
    } catch (err) {
      if (err instanceof ValidationError) problems.push(`Jugador ${p.number} · ${p.name}: ${err.message}`);
      else throw err;
    }
    if (p.active) {
      const clash = active.get(p.number);
      if (clash) problems.push(`Dorsal ${p.number} repetido entre jugadores activos (${clash.name} y ${p.name}).`);
      active.set(p.number, p);
    }
  }
  const playerIds = new Set(players.map((p) => p.id));
  for (const m of matches) problems.push(...matchProblems(m, playerIds));
  const allMatches = new Map(matches.map((m) => [m.id, m]));
  for (const e of events) problems.push(...eventProblems(e, allMatches.get(e.matchId)!));

  return {
    localTeam,
    link,
    players,
    matches,
    events,
    skippedMatches,
    problems,
    summary: {
      players: players.length,
      inactivePlayers: players.filter((p) => !p.active).length,
      matches: live.length,
      squadEntries: live.reduce((n, m) => n + m.squad.length, 0),
      events: events.length,
      deletedEvents: events.filter((e) => e.deletedAt !== null).length,
      pendingEvents: events.filter(isPending).length,
      freeThrows: events.filter((e) => e.deletedAt === null && e.kind === 'free_throw').length,
      additionalSanctions: events.filter((e) => e.deletedAt === null && e.addsToPrevious === true).length,
      scoreCorrections: live.filter((m) => m.scoreAdjustment.own !== 0 || m.scoreAdjustment.opponent !== 0).length,
      matchDeletions: deletions.length,
      skippedMatches: skippedMatches.length,
      skippedEvents: local.events.filter((e) => skippedIds.has(e.matchId)).length,
    },
  };
}
