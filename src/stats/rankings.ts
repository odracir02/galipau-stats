// Rankings: clasificaciones de jugadores a partir de los contadores del motor
// estadístico. No hay fórmulas propias: cada ranking lee una cifra que la app ya
// muestra (goles, eficacia, % paradas…). Ver docs/FORMULAS.md.
//
// El cálculo trabaja sobre una lista de candidatos, sin saber de qué equipo
// salen: hoy son los jugadores de un equipo y una temporada; más adelante
// podrán ser los de varios equipos de un club.
import type { Id } from '../domain/types';
import { efficiency, onTarget, savePct, type Counters, type SeasonStats } from './engine';

/** Mínimos de oportunidades para los rankings de porcentaje. */
export const RANKING_THRESHOLDS = {
  /** Lanzamientos para entrar en «El francotirador». */
  minShots: 10,
  /** Tiros a puerta recibidos (paradas + goles) para entrar en «El muro». */
  minGkOnTarget: 20,
} as const;

/** Puestos visibles en cada ranking. */
export const RANKING_LIMIT = 10;

export type RankingId =
  | 'top_scorer'
  | 'sharpshooter'
  | 'wall'
  | 'saves'
  | 'thief'
  | 'repeat_offender'
  | 'generous'
  | 'shots';

/** Jugador que puede aparecer en un ranking. */
export interface RankingCandidate {
  playerId: Id;
  name: string;
  number: number;
  matches: number;
  counters: Counters;
}

/** Cifra de un jugador en un ranking; null = no entra (sin actividad o bajo el mínimo). */
export interface RankingMeasure {
  value: number;
  /** Para porcentajes: aciertos y oportunidades (p. ej. 8/13). */
  made?: number;
  of?: number;
}

export interface RankingDefinition {
  id: RankingId;
  /** Nombre corto para el selector. */
  short: string;
  title: string;
  description: string;
  format: 'count' | 'pct';
  /** Unidad de la cifra (singular, plural) en los rankings de recuento. */
  unit?: readonly [string, string];
  /** Mínimo explicado en la interfaz (solo porcentajes). */
  minimum?: string;
  measure(c: Counters): RankingMeasure | null;
}

const count = (n: number): RankingMeasure | null => (n > 0 ? { value: n } : null);

/** Porcentaje redondeado a un decimal, como se muestra: dos cifras iguales en pantalla empatan. */
function ratio(made: number, of: number, min: number, value: number | null): RankingMeasure | null {
  if (of < min || value === null) return null;
  return { value: Math.round(value * 10) / 10, made, of };
}

const T = RANKING_THRESHOLDS;

export const RANKINGS: readonly RankingDefinition[] = [
  {
    id: 'top_scorer',
    short: 'Pistolero',
    title: 'El pistolero',
    description: 'Máximos goleadores: goles marcados en lanzamientos registrados.',
    format: 'count',
    unit: ['gol', 'goles'],
    measure: (c) => count(c.shots.goals),
  },
  {
    id: 'sharpshooter',
    short: 'Francotirador',
    title: 'El francotirador',
    description: 'Mayor eficacia en lanzamientos: goles / lanzamientos.',
    format: 'pct',
    minimum: `Mínimo ${T.minShots} lanzamientos.`,
    measure: (c) => ratio(c.shots.goals, c.shots.attempts, T.minShots, efficiency(c.shots)),
  },
  {
    id: 'wall',
    short: 'El muro',
    title: 'El muro',
    description: 'Mejor % de paradas de portero: paradas / (paradas + goles encajados). Los lanzamientos fuera no cuentan.',
    format: 'pct',
    minimum: `Mínimo ${T.minGkOnTarget} tiros a puerta (paradas + goles encajados).`,
    measure: (c) => ratio(c.gk.saves, onTarget(c.gk), T.minGkOnTarget, savePct(c.gk)),
  },
  {
    id: 'saves',
    short: 'Muro defensivo',
    title: 'Muro defensivo',
    description: 'Más paradas de portero.',
    format: 'count',
    unit: ['parada', 'paradas'],
    measure: (c) => count(c.gk.saves),
  },
  {
    id: 'thief',
    short: 'Ladrón',
    title: 'El ladrón',
    description: 'Más recuperaciones de balón.',
    format: 'count',
    unit: ['recuperación', 'recuperaciones'],
    measure: (c) => count(c.recoveries),
  },
  {
    id: 'repeat_offender',
    short: 'Reincidente',
    title: 'El reincidente',
    description: 'Más exclusiones de dos minutos. Defiende con tanta intensidad que el árbitro no le quita ojo.',
    format: 'count',
    unit: ['exclusión', 'exclusiones'],
    measure: (c) => count(c.exclusions),
  },
  {
    id: 'generous',
    short: 'Generoso',
    title: 'El generoso',
    description: 'Más pérdidas de balón (incluye pasos, dobles y pases fallados). Comparte el balón con todo el mundo, rivales incluidos.',
    format: 'count',
    unit: ['pérdida', 'pérdidas'],
    measure: (c) => count(c.turnovers.total),
  },
  {
    id: 'shots',
    short: 'Lanzamientos',
    title: 'Más lanzamientos',
    description: 'Total de lanzamientos realizados: goles + fuera + parados.',
    format: 'count',
    unit: ['lanzamiento', 'lanzamientos'],
    measure: (c) => count(c.shots.attempts),
  },
];

export function rankingById(id: RankingId): RankingDefinition {
  return RANKINGS.find((r) => r.id === id)!;
}

export interface RankedEntry extends RankingMeasure {
  /** Puesto compartido en caso de empate (1, 1, 3…). */
  position: number;
  player: RankingCandidate;
}

/**
 * Clasificación completa, sin límite: de mayor a menor, los empatados comparten
 * puesto y el siguiente salta (1, 1, 3). Dentro de un empate se ordena por
 * dorsal y nombre solo para presentar. Quien no tiene cifra no aparece.
 */
export function rankPlayers(def: RankingDefinition, candidates: readonly RankingCandidate[]): RankedEntry[] {
  const measured = candidates.flatMap((player) => {
    const m = def.measure(player.counters);
    return m ? [{ ...m, player }] : [];
  });
  measured.sort(
    (a, b) => b.value - a.value || a.player.number - b.player.number || a.player.name.localeCompare(b.player.name, 'es'),
  );
  const ranked: RankedEntry[] = [];
  measured.forEach((m, i) => {
    const prev = ranked[i - 1];
    ranked.push({ ...m, position: prev && prev.value === m.value ? prev.position : i + 1 });
  });
  return ranked;
}

export interface TopRanking {
  entries: RankedEntry[];
  /** Jugadores empatados en el último puesto visible que no caben en el límite. */
  hiddenTies: number;
}

/** Los primeros `limit` de una clasificación. */
export function topOf(ranked: readonly RankedEntry[], limit = RANKING_LIMIT): TopRanking {
  const entries = ranked.slice(0, limit);
  const last = entries.at(-1);
  const hiddenTies = last ? ranked.slice(limit).filter((e) => e.position === last.position).length : 0;
  return { entries, hiddenTies };
}

/** Puesto de un jugador en la clasificación completa (también fuera del Top 10). */
export function positionOf(ranked: readonly RankedEntry[], playerId: Id): RankedEntry | undefined {
  return ranked.find((e) => e.player.playerId === playerId);
}

/** Candidatos de un acumulado de temporada, con el nombre y dorsal de su última convocatoria. */
export function seasonCandidates(stats: SeasonStats): RankingCandidate[] {
  return [...stats.players.values()].map((p) => ({
    playerId: p.playerId,
    name: p.latest.name,
    number: p.latest.number,
    matches: p.matches,
    counters: p.counters,
  }));
}
