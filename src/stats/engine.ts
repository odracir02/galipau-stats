// Motor estadístico. Funciones puras que derivan todas las cifras de los eventos.
// Nunca se guardan contadores: si un evento se edita o se borra, basta con volver
// a calcular. Ver docs/FORMULAS.md.
import { FIELD_SHOT_TYPES, GK_SHOT_TYPES } from '../domain/catalog';
import { MINUTE_MS, periodEndMs, periodStartMs } from '../clock/clock';
import { redCards, type RedCard } from './discipline';
import type {
  FieldShotType,
  GkShotType,
  Id,
  Match,
  MatchEvent,
  Period,
  SquadEntry,
} from '../domain/types';

export interface ShotLine {
  goals: number;
  out: number;
  saved: number;
  /** Lanzamientos = goles + fuera + parados. */
  attempts: number;
}

export interface GkLine {
  /** Goles recibidos. */
  goals: number;
  saves: number;
  out: number;
  /** Lanzamientos recibidos = goles + paradas + fuera. */
  received: number;
}

export interface TurnoverLine {
  /** Pérdidas totales = general + pasos + dobles + pases fallados. */
  total: number;
  general: number;
  steps: number;
  double: number;
  badPass: number;
}

/** Contadores derivados de un conjunto de eventos (un jugador, el equipo, un intervalo…). */
export interface Counters {
  shots: ShotLine;
  shotsByType: Record<FieldShotType, ShotLine>;
  gk: GkLine;
  gkByType: Record<GkShotType, GkLine>;
  turnovers: TurnoverLine;
  recoveries: number;
  yellows: number;
  exclusions: number;
  /** Rojas = directas + por acumulación (ver discipline.ts). */
  reds: number;
  redsDirect: number;
  /** Rojas derivadas de la tercera exclusión; no existen como evento. */
  redsAccumulated: number;
  freeThrows: number;
  penaltiesCommitted: number;
}

const emptyShotLine = (): ShotLine => ({ goals: 0, out: 0, saved: 0, attempts: 0 });
const emptyGkLine = (): GkLine => ({ goals: 0, saves: 0, out: 0, received: 0 });

export function emptyCounters(): Counters {
  return {
    shots: emptyShotLine(),
    shotsByType: Object.fromEntries(FIELD_SHOT_TYPES.map((t) => [t, emptyShotLine()])) as Record<
      FieldShotType,
      ShotLine
    >,
    gk: emptyGkLine(),
    gkByType: Object.fromEntries(GK_SHOT_TYPES.map((t) => [t, emptyGkLine()])) as Record<
      GkShotType,
      GkLine
    >,
    turnovers: { total: 0, general: 0, steps: 0, double: 0, badPass: 0 },
    recoveries: 0,
    yellows: 0,
    exclusions: 0,
    reds: 0,
    redsDirect: 0,
    redsAccumulated: 0,
    freeThrows: 0,
    penaltiesCommitted: 0,
  };
}

/** Suma un evento a los contadores (mutación local sobre un objeto recién creado). */
function addEvent(c: Counters, e: MatchEvent): void {
  switch (e.kind) {
    case 'shot': {
      for (const line of [c.shots, c.shotsByType[e.shotType]]) {
        line.attempts++;
        if (e.result === 'goal') line.goals++;
        else if (e.result === 'out') line.out++;
        else line.saved++;
      }
      return;
    }
    case 'gk_shot': {
      for (const line of [c.gk, c.gkByType[e.shotType]]) {
        line.received++;
        if (e.result === 'goal') line.goals++;
        else if (e.result === 'save') line.saves++;
        else line.out++;
      }
      return;
    }
    case 'turnover': {
      // Pasos, dobles y pase fallado cuentan también como pérdida.
      c.turnovers.total++;
      if (e.turnoverType === 'general') c.turnovers.general++;
      else if (e.turnoverType === 'steps') c.turnovers.steps++;
      else if (e.turnoverType === 'double') c.turnovers.double++;
      else c.turnovers.badPass++;
      return;
    }
    case 'recovery':
      c.recoveries++;
      return;
    case 'yellow':
      c.yellows++;
      return;
    case 'exclusion':
      c.exclusions++;
      return;
    case 'red':
      // Las rojas no se cuentan evento a evento: salen de redCards(), que
      // añade la roja por acumulación y evita duplicados.
      return;
    case 'free_throw':
      c.freeThrows++;
      return;
    case 'penalty_committed':
      c.penaltiesCommitted++;
      return;
  }
}

function addShotLine(a: ShotLine, b: ShotLine): ShotLine {
  return {
    goals: a.goals + b.goals,
    out: a.out + b.out,
    saved: a.saved + b.saved,
    attempts: a.attempts + b.attempts,
  };
}

function addGkLine(a: GkLine, b: GkLine): GkLine {
  return {
    goals: a.goals + b.goals,
    saves: a.saves + b.saves,
    out: a.out + b.out,
    received: a.received + b.received,
  };
}

/** Suma de contadores (temporada = suma de partidos). No muta las entradas. */
export function sumCounters(a: Counters, b: Counters): Counters {
  return {
    shots: addShotLine(a.shots, b.shots),
    shotsByType: Object.fromEntries(
      FIELD_SHOT_TYPES.map((t) => [t, addShotLine(a.shotsByType[t], b.shotsByType[t])]),
    ) as Record<FieldShotType, ShotLine>,
    gk: addGkLine(a.gk, b.gk),
    gkByType: Object.fromEntries(
      GK_SHOT_TYPES.map((t) => [t, addGkLine(a.gkByType[t], b.gkByType[t])]),
    ) as Record<GkShotType, GkLine>,
    turnovers: {
      total: a.turnovers.total + b.turnovers.total,
      general: a.turnovers.general + b.turnovers.general,
      steps: a.turnovers.steps + b.turnovers.steps,
      double: a.turnovers.double + b.turnovers.double,
      badPass: a.turnovers.badPass + b.turnovers.badPass,
    },
    recoveries: a.recoveries + b.recoveries,
    yellows: a.yellows + b.yellows,
    exclusions: a.exclusions + b.exclusions,
    reds: a.reds + b.reds,
    redsDirect: a.redsDirect + b.redsDirect,
    redsAccumulated: a.redsAccumulated + b.redsAccumulated,
    freeThrows: a.freeThrows + b.freeThrows,
    penaltiesCommitted: a.penaltiesCommitted + b.penaltiesCommitted,
  };
}

function addRedCard(c: Counters, card: RedCard): void {
  c.reds++;
  if (card.type === 'direct') c.redsDirect++;
  else c.redsAccumulated++;
}

/** Contadores de todo menos las rojas. */
function countRaw(events: readonly MatchEvent[]): Counters {
  const c = emptyCounters();
  for (const e of events) if (e.deletedAt === null) addEvent(c, e);
  return c;
}

/** Contadores de un conjunto completo de eventos de un partido (rojas incluidas). */
export function countEvents(events: readonly MatchEvent[]): Counters {
  const c = countRaw(events);
  for (const card of redCards(events)) addRedCard(c, card);
  return c;
}

// --- Fórmulas ----------------------------------------------------------------

/** Porcentaje, o null cuando el denominador es 0 (se muestra «sin datos»). */
export function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

/** Eficacia = goles / lanzamientos × 100. */
export function efficiency(line: ShotLine): number | null {
  return pct(line.goals, line.attempts);
}

/** Tiros entre los tres palos = paradas + goles recibidos (los fuera no cuentan). */
export function onTarget(line: GkLine): number {
  return line.saves + line.goals;
}

/** % paradas = paradas / (paradas + goles recibidos) × 100. */
export function savePct(line: GkLine): number | null {
  return pct(line.saves, onTarget(line));
}

/** Sanciones = amarillas + exclusiones + rojas. */
export function sanctions(c: Counters): number {
  return c.yellows + c.exclusions + c.reds;
}

// --- Partido ----------------------------------------------------------------

export interface Score {
  /** Goles acreditados por eventos (incluye pendientes de atribución). */
  ownFromEvents: number;
  opponentFromEvents: number;
  ownAdjustment: number;
  opponentAdjustment: number;
  own: number;
  opponent: number;
}

export interface IntervalStats {
  /** Minuto final del intervalo (5, 10, …, 60). */
  endMinute: number;
  period: Period;
  counters: Counters;
}

export interface MatchStats {
  team: Counters;
  /** Contadores por jugador convocado (solo eventos atribuidos). */
  players: Map<Id, Counters>;
  pendingCount: number;
  score: Score;
  intervals: IntervalStats[];
}

export const INTERVAL_MINUTES = 5;

/**
 * Índice de intervalo de cinco minutos de un evento. Los eventos de una parte
 * que se prolonga más allá de su final nominal caen en el último intervalo de
 * esa parte (nunca en la parte siguiente).
 */
export function intervalIndex(e: Pick<MatchEvent, 'period' | 'matchTimeMs'>, halfMinutes: number): number {
  const perHalf = Math.max(1, Math.ceil(halfMinutes / INTERVAL_MINUTES));
  const start = periodStartMs(e.period, halfMinutes);
  const end = periodEndMs(e.period, halfMinutes);
  const t = Math.min(Math.max(e.matchTimeMs, start), end - 1);
  const within = Math.floor((t - start) / (INTERVAL_MINUTES * MINUTE_MS));
  return (e.period - 1) * perHalf + Math.min(within, perHalf - 1);
}

export function computeIntervals(match: Pick<Match, 'halfMinutes'>, events: readonly MatchEvent[]): IntervalStats[] {
  const perHalf = Math.max(1, Math.ceil(match.halfMinutes / INTERVAL_MINUTES));
  const buckets: MatchEvent[][] = Array.from({ length: perHalf * 2 }, () => []);
  for (const e of events) {
    if (e.deletedAt !== null) continue;
    buckets[intervalIndex(e, match.halfMinutes)]?.push(e);
  }
  const intervals = buckets.map((bucket, i) => {
    const period: Period = i < perHalf ? 1 : 2;
    const endMinute = Math.min(
      (period - 1) * match.halfMinutes + ((i % perHalf) + 1) * INTERVAL_MINUTES,
      period * match.halfMinutes,
    );
    return { endMinute, period, counters: countRaw(bucket) };
  });
  // Cada roja cae en el tramo del evento que la provoca (p. ej. la 3.ª exclusión).
  for (const card of redCards(events)) {
    const iv = intervals[intervalIndex(card, match.halfMinutes)];
    if (iv) addRedCard(iv.counters, card);
  }
  return intervals;
}

export function computeScore(match: Pick<Match, 'scoreAdjustment'>, team: Counters): Score {
  const ownFromEvents = team.shots.goals;
  const opponentFromEvents = team.gk.goals;
  return {
    ownFromEvents,
    opponentFromEvents,
    ownAdjustment: match.scoreAdjustment.own,
    opponentAdjustment: match.scoreAdjustment.opponent,
    own: Math.max(0, ownFromEvents + match.scoreAdjustment.own),
    opponent: Math.max(0, opponentFromEvents + match.scoreAdjustment.opponent),
  };
}

export type MatchResult = 'win' | 'loss' | 'draw';

/**
 * Resultado para nuestro equipo. `own` y `opponent` ya son nuestros goles y los
 * del rival (con correcciones), sea cual sea el campo: no se compara el lado
 * izquierdo con el derecho del marcador.
 */
export function matchResult(score: Pick<Score, 'own' | 'opponent'>): MatchResult {
  if (score.own > score.opponent) return 'win';
  if (score.own < score.opponent) return 'loss';
  return 'draw';
}

export function computeMatchStats(
  match: Pick<Match, 'squad' | 'scoreAdjustment' | 'halfMinutes'>,
  events: readonly MatchEvent[],
): MatchStats {
  const live = events.filter((e) => e.deletedAt === null);
  const team = countEvents(live);

  const players = new Map<Id, Counters>();
  for (const entry of match.squad) players.set(entry.playerId, emptyCounters());
  let pendingCount = 0;
  for (const e of live) {
    if (e.playerId === null) {
      pendingCount++;
      continue;
    }
    let c = players.get(e.playerId);
    if (!c) {
      // Jugador ya no convocado (dato antiguo): se conserva, no se descarta.
      c = emptyCounters();
      players.set(e.playerId, c);
    }
    addEvent(c, e);
  }
  for (const card of redCards(live)) {
    if (card.playerId === null) continue;
    const c = players.get(card.playerId);
    if (c) addRedCard(c, card);
  }

  return {
    team,
    players,
    pendingCount,
    score: computeScore(match, team),
    intervals: computeIntervals(match, live),
  };
}

// --- Temporada --------------------------------------------------------------

export interface SeasonPlayer {
  playerId: Id;
  /** Datos de la convocatoria más reciente (nombre/dorsal de ese momento). */
  latest: SquadEntry;
  /** Partidos en los que figura en la convocatoria registrada. */
  matches: number;
  counters: Counters;
}

export interface SeasonStats {
  matches: number;
  team: Counters;
  goalsFor: number;
  goalsAgainst: number;
  pendingCount: number;
  players: Map<Id, SeasonPlayer>;
  /** Intervalos acumulados; null si los partidos tienen duraciones distintas. */
  intervals: IntervalStats[] | null;
}

export interface MatchWithEvents {
  match: Match;
  events: readonly MatchEvent[];
}

/**
 * Acumulado de temporada: se suman los contadores de cada partido y los
 * porcentajes se calculan después sobre los totales (nunca promediando
 * porcentajes). Los goles del marcador incluyen las correcciones manuales.
 */
export function computeSeasonStats(items: readonly MatchWithEvents[]): SeasonStats {
  const sorted = [...items].sort((a, b) =>
    a.match.date === b.match.date
      ? a.match.createdAt.localeCompare(b.match.createdAt)
      : a.match.date.localeCompare(b.match.date),
  );
  let team = emptyCounters();
  let goalsFor = 0;
  let goalsAgainst = 0;
  let pendingCount = 0;
  const players = new Map<Id, SeasonPlayer>();
  const sameDuration = new Set(sorted.map((i) => i.match.halfMinutes)).size <= 1;
  let intervals: IntervalStats[] | null = null;

  for (const { match, events } of sorted) {
    const stats = computeMatchStats(match, events);
    team = sumCounters(team, stats.team);
    if (sameDuration) {
      intervals = intervals
        ? intervals.map((iv, i) => ({ ...iv, counters: sumCounters(iv.counters, stats.intervals[i]!.counters) }))
        : stats.intervals;
    }
    goalsFor += stats.score.own;
    goalsAgainst += stats.score.opponent;
    pendingCount += stats.pendingCount;

    for (const entry of match.squad) {
      const prev = players.get(entry.playerId);
      const counters = stats.players.get(entry.playerId) ?? emptyCounters();
      players.set(entry.playerId, {
        playerId: entry.playerId,
        latest: entry,
        matches: (prev?.matches ?? 0) + 1,
        counters: prev ? sumCounters(prev.counters, counters) : counters,
      });
    }
  }

  return { matches: sorted.length, team, goalsFor, goalsAgainst, pendingCount, players, intervals };
}

/** Media por partido, o null si no hay partidos. */
export function perMatch(total: number, matches: number): number | null {
  return matches > 0 ? total / matches : null;
}
