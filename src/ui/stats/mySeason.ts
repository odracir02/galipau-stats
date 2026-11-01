// Temporada del jugador de «Mi jugador», con el motor de siempre: los mismos
// partidos que «Temporada» y los rankings (seasonItems) y el mismo acumulado
// (computeSeasonStats). El resumen de la pestaña y la ficha completa salen de
// aquí, así que siempre coinciden. Solo presenta: no cambia ninguna regla.
import type { Id, Match, Position } from '../../domain/types';
import type { TeamSnapshot } from '../../remote/api';
import { seasonItems } from '../../remote/viewer';
import { computeMatchStats, computeSeasonStats, emptyCounters, onTarget, type Counters, type Score } from '../../stats/engine';
import { positionOf, rankPlayers, RANKING_LIMIT, rankingById, seasonCandidates, type RankedEntry, type RankingDefinition, type RankingId } from '../../stats/rankings';
import type { StatRow } from './StatTables';

export interface MySeason {
  /**
   * Fila del jugador en la temporada: la de «Temporada» si figura en alguna
   * convocatoria y, si no, a cero (con sus datos de la plantilla).
   */
  row: StatRow;
  /** Partidos con convocatoria registrada (definición del motor, la de la ficha). */
  matches: number;
  /** De ellos, finalizados y en juego ahora (en curso o en el descanso). */
  finished: number;
  live: number;
}

const playing = (status: string) => status === 'in_progress' || status === 'halftime';

export function mySeason(
  snapshot: TeamSnapshot,
  player: { id: Id; name: string; number: number; position: StatRow['position'] },
  season: string,
): MySeason {
  const items = seasonItems(snapshot).filter((i) => i.match.season === season);
  const stats = computeSeasonStats(items);
  const p = stats.players.get(player.id);
  const counters: Counters = p?.counters ?? emptyCounters();
  const row: StatRow = p
    ? { ...p.latest, matches: p.matches, counters }
    : { playerId: player.id, number: player.number, name: player.name, position: player.position, matches: 0, counters };
  const convoked = items.filter((i) => i.match.squad.some((s) => s.playerId === player.id && s.role !== 'official'));
  return {
    row,
    matches: p?.matches ?? 0,
    finished: convoked.filter((i) => i.match.status === 'finished').length,
    live: convoked.filter((i) => playing(i.match.status)).length,
  };
}

// --- Rankings personales ----------------------------------------------------------

/**
 * Clasificaciones positivas que se destacan en «Mi jugador», las principales
 * primero según su posición. Las de exclusiones y pérdidas no se destacan aquí
 * (siguen en la pantalla de rankings).
 */
const POSITIVE: Record<Position, readonly RankingId[]> = {
  field: ['top_scorer', 'sharpshooter', 'shots', 'thief'],
  goalkeeper: ['wall', 'thief', 'top_scorer'],
};
/** Las que se muestran aunque aún no entre (explicando por qué); el resto, solo si entra. */
const MAIN: Record<Position, readonly RankingId[]> = { field: ['top_scorer', 'sharpshooter'], goalkeeper: ['wall'] };

export interface MyRanking {
  def: RankingDefinition;
  /** Su puesto en la clasificación completa (también fuera del Top 10); null si no entra. */
  entry: RankedEntry | null;
  /** Jugadores clasificados (solo el número: nunca quiénes son más allá del Top 10). */
  ranked: number;
  inTop: boolean;
}

/**
 * Puesto del jugador en cada clasificación positiva de la temporada, con los
 * criterios del motor (rankPlayers, positionOf). Sin cifra o bajo el mínimo,
 * no tiene puesto: no se inventa.
 */
export function myRankings(snapshot: TeamSnapshot, playerId: Id, position: Position, season: string): MyRanking[] {
  const stats = computeSeasonStats(seasonItems(snapshot).filter((i) => i.match.season === season));
  if (stats.matches === 0) return [];
  const candidates = seasonCandidates(stats);
  return POSITIVE[position].flatMap((id) => {
    const def = rankingById(id);
    const ranked = rankPlayers(def, candidates);
    const entry = positionOf(ranked, playerId) ?? null;
    if (!entry && !MAIN[position].includes(id)) return [];
    return [{ def, entry, ranked: ranked.length, inTop: entry !== null && entry.position <= RANKING_LIMIT }];
  });
}

// --- Partidos ---------------------------------------------------------------------

export interface MyMatch {
  match: Match;
  score: Score;
  /** Su entrada en la convocatoria de ese partido; null si no está convocado. */
  position: Position | null;
  /** Sus cifras en el partido (solo sus acciones); null si no está convocado. */
  counters: Counters | null;
}

const isPlaying = (m: Match) => m.status === 'in_progress' || m.status === 'halftime';

function matchesOf(snapshot: TeamSnapshot): { match: Match; events: TeamSnapshot['events'][number]['event'][] }[] {
  // seasonItems: sin partidos borrados ni preparados sin acciones (los criterios de siempre).
  return seasonItems(snapshot)
    .map((i) => ({ match: i.match, events: [...i.events] }))
    .sort((a, b) => b.match.date.localeCompare(a.match.date) || b.match.createdAt.localeCompare(a.match.createdAt));
}

function mine(match: Match, events: TeamSnapshot['events'][number]['event'][], playerId: Id): MyMatch {
  const stats = computeMatchStats(match, events);
  const entry = match.squad.find((s) => s.playerId === playerId && s.role !== 'official');
  return { match, score: stats.score, position: entry?.position ?? null, counters: entry ? (stats.players.get(playerId) ?? emptyCounters()) : null };
}

/** Últimos partidos finalizados de la temporada en los que figura convocado (como mucho `limit`). */
export function recentMatches(snapshot: TeamSnapshot, playerId: Id, season: string, limit = 3): MyMatch[] {
  return matchesOf(snapshot)
    .filter(({ match }) => match.season === season && match.status === 'finished' && match.squad.some((s) => s.playerId === playerId && s.role !== 'official'))
    .slice(0, limit)
    .map(({ match, events }) => mine(match, events, playerId));
}

/** Partidos en juego ahora (en curso o en el descanso), esté convocado o no. */
export function liveMatches(snapshot: TeamSnapshot, playerId: Id): MyMatch[] {
  return matchesOf(snapshot)
    .filter(({ match }) => isPlaying(match))
    .map(({ match, events }) => mine(match, events, playerId));
}

/**
 * Resumen corto de sus cifras en un partido, sin porcentajes: «2 goles de 3
 * lanzamientos», «5 paradas de 9 entre palos». Sin acciones, null.
 */
export function matchLine(c: Counters, position: Position): string | null {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (position === 'goalkeeper' && c.gk.received > 0) {
    parts.push(onTarget(c.gk) > 0 ? `${plural(c.gk.saves, 'parada', 'paradas')} de ${onTarget(c.gk)} entre palos` : plural(c.gk.out, 'lanzamiento fuera', 'lanzamientos fuera'));
  }
  if (c.shots.attempts > 0) parts.push(`${plural(c.shots.goals, 'gol', 'goles')} de ${plural(c.shots.attempts, 'lanzamiento', 'lanzamientos')}`);
  if (c.recoveries > 0) parts.push(plural(c.recoveries, 'recuperación', 'recuperaciones'));
  return parts.length ? parts.join(' · ') : null;
}
