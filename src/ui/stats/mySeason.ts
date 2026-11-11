// Temporada del jugador de «Mi jugador», con el motor de siempre: los mismos
// partidos que «Temporada» y los rankings (seasonItems) y el mismo acumulado
// (computeSeasonStats). El resumen de la pestaña y la ficha completa salen de
// aquí, así que siempre coinciden. Solo presenta: no cambia ninguna regla.
import type { Id, Match, Position } from '../../domain/types';
import type { TeamSnapshot } from '../../remote/api';
import { seasonItems } from '../../remote/viewer';
import {
  computeMatchStats,
  computeSeasonStats,
  efficiency,
  emptyCounters,
  matchResult,
  onTarget,
  perMatch,
  savePct,
  sumCounters,
  type Counters,
  type MatchResult,
  type Score,
} from '../../stats/engine';
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
  field: ['top_scorer', 'sharpshooter', 'shots', 'thief', 'penalty_specialist', 'speedster'],
  goalkeeper: ['wall', 'penalty_stopper', 'thief', 'top_scorer'],
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

// --- Evolución partido a partido ---------------------------------------------------
//
// Base de la evolución personal (todavía sin interfaz). Solo partidos FINALIZADOS
// con convocatoria: un partido en juego cambiaría a medias la serie y las medias.
// Los partidos son los de siempre (seasonItems: sin borrados ni preparados sin
// acciones) y las cifras de cada uno, las del motor (computeMatchStats vía mine):
// sin acciones anuladas y sin las que no tienen jugador asignado.
//
// Estar convocado NO significa haber jugado: no se registran minutos ni quién está
// en pista. Una convocatoria sin acciones registradas es solo eso.

/** Partidos que se muestran en la evolución (los más recientes). */
export const SERIES_LIMIT = 10;
/** Partidos de la comparación «últimos frente a temporada». */
export const RECENT_MATCHES = 3;
/** Partidos finalizados con convocatoria necesarios para comparar. */
export const RECENT_MIN_MATCHES = 6;

export interface MyMatchPoint {
  matchId: Id;
  date: Match['date'];
  opponent: string;
  venue: Match['venue'];
  score: Pick<Score, 'own' | 'opponent'>;
  result: MatchResult;
  /** Posición con la que figura en la convocatoria de ESTE partido. */
  position: Position;
  /** Sus cifras en el partido (a cero si no tiene acciones). */
  counters: Counters;
  /** Acciones válidas atribuidas a su ficha (sin anuladas ni sin asignar). */
  actions: number;
  /** Lanzamientos entre palos recibidos y registrados como portero (paradas + goles). */
  gkOnTarget: number;
}

export interface MyCounts {
  /** Convocatorias de la temporada, también en partidos en juego (la cifra de «Temporada»). */
  convocations: number;
  /** De ellas, en partidos finalizados. */
  finished: number;
  /** Partidos finalizados con alguna acción válida atribuida a su ficha. */
  finishedWithActions: number;
  /** Partidos finalizados con lanzamientos entre palos recibidos y registrados. */
  finishedWithShotsOnTarget: number;
}

/** Acumulado de un conjunto de partidos finalizados en una misma posición. */
export interface MyAggregate {
  position: Position;
  /** Partidos finalizados con convocatoria en esta posición. */
  matches: number;
  /** De ellos, con alguna acción válida atribuida. */
  withActions: number;
  /** De ellos, con lanzamientos entre palos recibidos (denominador de las medias de portero). */
  withShotsOnTarget: number;
  /** Suma de sus contadores: los porcentajes se calculan sobre esta suma, nunca promediando. */
  counters: Counters;
}

export interface MyAverage {
  key: 'goals' | 'attempts' | 'recoveries' | 'turnovers' | 'saves' | 'goalsConceded' | 'onTarget';
  total: number;
  /** Denominador explícito: entre cuántos partidos se divide. */
  denominator: number;
  per: 'finished_convocations' | 'finished_with_shots_on_target';
  /** total / denominador; null sin partidos (nunca un 0 engañoso). */
  value: number | null;
}

export interface MyComparison {
  position: Position;
  /** Los últimos RECENT_MATCHES partidos finalizados con convocatoria en esta posición. */
  recent: MyAggregate;
  /** Fechas del primero y del último de esos partidos (el periodo de «Últimos 3»). */
  recentDates: { from: Match['date']; to: Match['date'] };
  /** Todos los partidos finalizados con convocatoria en esta posición (incluidos los recientes). */
  season: MyAggregate;
}

export interface MyEvolution {
  counts: MyCounts;
  /** Los últimos SERIES_LIMIT partidos finalizados con convocatoria, del más antiguo al más reciente. */
  series: MyMatchPoint[];
  /** Acumulado por posición de todos los finalizados (null si nunca figura en esa posición). */
  byPosition: Record<Position, MyAggregate | null>;
  /** Convocado como portero en unos partidos y como jugador de campo en otros. */
  mixedPositions: boolean;
  /** Comparación por posición, solo con al menos RECENT_MIN_MATCHES partidos en ella. */
  comparisons: MyComparison[];
}

/** Orden cronológico estable: fecha y creación (como el motor) y, por último, el identificador. */
const chronological = (a: Match, b: Match) =>
  a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const convokedIn = (match: Match, playerId: Id) => match.squad.some((s) => s.playerId === playerId && s.role !== 'official');

/**
 * Todos los partidos finalizados de la temporada en los que figura convocado,
 * del más antiguo al más reciente, con sus cifras de cada uno.
 */
export function myMatchSeries(snapshot: TeamSnapshot, playerId: Id, season: string): MyMatchPoint[] {
  return seasonItems(snapshot)
    .filter(({ match }) => match.season === season && match.status === 'finished' && convokedIn(match, playerId))
    .sort((a, b) => chronological(a.match, b.match))
    .map(({ match, events }) => {
      const m = mine(match, [...events], playerId);
      const counters = m.counters ?? emptyCounters();
      return {
        matchId: match.id,
        date: match.date,
        opponent: match.opponent,
        venue: match.venue,
        score: { own: m.score.own, opponent: m.score.opponent },
        result: matchResult(m.score),
        position: m.position!,
        counters,
        // Válidas = las que cuenta el motor: no anuladas y atribuidas a su ficha.
        actions: events.filter((e) => e.deletedAt === null && e.playerId === playerId).length,
        gkOnTarget: onTarget(counters.gk),
      };
    });
}

function aggregate(position: Position, points: readonly MyMatchPoint[]): MyAggregate {
  return {
    position,
    matches: points.length,
    withActions: points.filter((p) => p.actions > 0).length,
    withShotsOnTarget: points.filter((p) => p.gkOnTarget > 0).length,
    counters: points.reduce((acc, p) => sumCounters(acc, p.counters), emptyCounters()),
  };
}

const POSITIONS: readonly Position[] = ['field', 'goalkeeper'];

/** Recuentos, serie reciente, acumulados por posición y comparación (si hay partidos suficientes). */
export function myEvolution(snapshot: TeamSnapshot, playerId: Id, season: string): MyEvolution {
  const all = myMatchSeries(snapshot, playerId, season);
  const convocations = seasonItems(snapshot).filter(({ match }) => match.season === season && convokedIn(match, playerId)).length;
  const of = (position: Position) => all.filter((p) => p.position === position);
  const byPosition = {
    field: of('field').length ? aggregate('field', of('field')) : null,
    goalkeeper: of('goalkeeper').length ? aggregate('goalkeeper', of('goalkeeper')) : null,
  };
  return {
    counts: {
      convocations,
      finished: all.length,
      finishedWithActions: all.filter((p) => p.actions > 0).length,
      finishedWithShotsOnTarget: all.filter((p) => p.gkOnTarget > 0).length,
    },
    series: all.slice(-SERIES_LIMIT),
    byPosition,
    mixedPositions: byPosition.field !== null && byPosition.goalkeeper !== null,
    comparisons: POSITIONS.filter((pos) => of(pos).length >= RECENT_MIN_MATCHES).map((pos) => {
      const recent = of(pos).slice(-RECENT_MATCHES);
      return {
        position: pos,
        recent: aggregate(pos, recent),
        recentDates: { from: recent[0]!.date, to: recent.at(-1)!.date },
        season: byPosition[pos]!,
      };
    }),
  };
}

/**
 * Medias por partido de un acumulado, cada una con su denominador:
 * - campo: por partido finalizado con convocatoria en esa posición;
 * - portero: paradas, encajados y entre palos por partido finalizado con
 *   lanzamientos entre palos recibidos (una convocatoria como suplente sin
 *   recibir nada no rebaja sus medias); recuperaciones, por convocatoria.
 */
export function myAverages(a: MyAggregate): MyAverage[] {
  const c = a.counters;
  const item = (key: MyAverage['key'], total: number, per: MyAverage['per']): MyAverage => {
    const denominator = per === 'finished_convocations' ? a.matches : a.withShotsOnTarget;
    return { key, total, denominator, per, value: perMatch(total, denominator) };
  };
  if (a.position === 'goalkeeper') {
    return [
      item('saves', c.gk.saves, 'finished_with_shots_on_target'),
      item('goalsConceded', c.gk.goals, 'finished_with_shots_on_target'),
      item('onTarget', onTarget(c.gk), 'finished_with_shots_on_target'),
      item('recoveries', c.recoveries, 'finished_convocations'),
    ];
  }
  return [
    item('goals', c.shots.goals, 'finished_convocations'),
    item('attempts', c.shots.attempts, 'finished_convocations'),
    item('recoveries', c.recoveries, 'finished_convocations'),
    item('turnovers', c.turnovers.total, 'finished_convocations'),
  ];
}

/**
 * Media principal del resumen de temporada en la posición que se muestra:
 * goles por convocatoria en partido finalizado (campo) o paradas por partido
 * finalizado con lanzamientos entre palos (portero). Solo cuenta los partidos
 * en esa posición; null si nunca ha figurado en ella en un partido finalizado.
 */
export function mainAverage(evolution: MyEvolution, position: Position): MyAverage | null {
  const aggregate = evolution.byPosition[position];
  if (!aggregate) return null;
  return myAverages(aggregate).find((a) => a.key === (position === 'goalkeeper' ? 'saves' : 'goals')) ?? null;
}

/**
 * Medias de la comparación «últimos frente a temporada», con la métrica principal
 * de su posición y el mismo denominador que el resumen: goles por convocatoria en
 * partido finalizado (campo) o paradas por partido finalizado con lanzamientos
 * entre palos (portero). Cada posición por separado: nunca se mezclan.
 */
export function comparisonAverages(c: MyComparison): { recent: MyAverage; season: MyAverage } {
  const key = c.position === 'goalkeeper' ? 'saves' : 'goals';
  const pick = (a: MyAggregate) => myAverages(a).find((x) => x.key === key)!;
  return { recent: pick(c.recent), season: pick(c.season) };
}

/** Partidos finalizados con convocatoria en la otra posición (jugador con ambas). */
export function otherPositionMatches(evolution: MyEvolution, position: Position): number {
  return evolution.byPosition[position === 'goalkeeper' ? 'field' : 'goalkeeper']?.matches ?? 0;
}

/** Porcentaje principal de un acumulado, sobre sus contadores sumados: eficacia o % de paradas. */
export function myRate(a: MyAggregate): number | null {
  return a.position === 'goalkeeper' ? savePct(a.counters.gk) : efficiency(a.counters.shots);
}

// --- Barras de evolución -------------------------------------------------------------

/** Barra de un partido: aciertos sobre el total registrado, según su posición en ESE partido. */
export interface EvolutionBar {
  matchId: Id;
  date: Match['date'];
  opponent: string;
  position: Position;
  /** Campo: goles. Portero: paradas. */
  made: number;
  /** Campo: lanzamientos registrados. Portero: lanzamientos entre palos recibidos. */
  total: number;
}

export interface EvolutionBars {
  /** Como mucho SERIES_LIMIT, en el orden recibido (cronológico). */
  bars: EvolutionBar[];
  /**
   * Escala de cada posición: el mayor total de la serie en esa posición (al menos 1).
   * Los partidos de una misma posición son comparables entre sí; los lanzamientos
   * de campo y los recibidos entre palos no se miden con la misma regla.
   */
  scales: Record<Position, number>;
  /** Hay partidos en las dos posiciones. */
  mixed: boolean;
}

/**
 * Barras de la serie de N-B, sin cálculos nuevos: toma de cada partido los
 * contadores que ya trae (lanzamientos o portería según su convocatoria).
 */
export function evolutionBars(points: readonly MyMatchPoint[]): EvolutionBars {
  const bars = points.slice(-SERIES_LIMIT).map(
    (p): EvolutionBar => ({
      matchId: p.matchId,
      date: p.date,
      opponent: p.opponent,
      position: p.position,
      made: p.position === 'goalkeeper' ? p.counters.gk.saves : p.counters.shots.goals,
      total: p.position === 'goalkeeper' ? p.gkOnTarget : p.counters.shots.attempts,
    }),
  );
  const scaleOf = (position: Position) => Math.max(1, ...bars.filter((b) => b.position === position).map((b) => b.total));
  return {
    bars,
    scales: { field: scaleOf('field'), goalkeeper: scaleOf('goalkeeper') },
    mixed: new Set(bars.map((b) => b.position)).size > 1,
  };
}
