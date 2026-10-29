import { isTeamKind, MATCH_STATUS_LABEL } from '../../domain/catalog';
import type { EventKind, MatchStatus, SquadEntry } from '../../domain/types';
import { matchResult, type MatchResult, type Score } from '../../stats/engine';
import { REDUCTION_MS, type ActiveReduction } from '../../stats/exclusions';

/** Jugador de una acción; las acciones de equipo sin jugador se muestran como «Equipo». */
export function playerLabel(squad: readonly SquadEntry[], playerId: string | null, kind?: EventKind): string {
  if (playerId === null) return kind && isTeamKind(kind) ? 'Equipo' : 'Sin asignar';
  const s = squad.find((x) => x.playerId === playerId);
  return s ? `${s.number} · ${s.name}` : 'Jugador desconocido';
}

export interface StatusBadge {
  label: string;
  /** Sufijo de la clase CSS `status-…`. */
  tone: MatchStatus | MatchResult;
}

const RESULT_LABEL: Record<MatchResult, string> = { win: 'Victoria', loss: 'Derrota', draw: 'Empate' };

/**
 * Etiqueta de estado de un partido en la lista. Los finalizados muestran el
 * resultado para nuestro equipo (marcador con correcciones); el resto, su estado.
 */
export function statusBadge(status: MatchStatus, score: Pick<Score, 'own' | 'opponent'>): StatusBadge {
  if (status !== 'finished') return { label: MATCH_STATUS_LABEL[status], tone: status };
  const result = matchResult(score);
  return { label: RESULT_LABEL[result], tone: result };
}

/**
 * Etiqueta corta de una inferioridad: «Roja» (directa o por 3.ª exclusión) y la
 * duración si no es la normal, como en la planilla («Roja 4'», «4'»).
 */
export function reductionTag(r: Pick<ActiveReduction, 'kind' | 'durationMs'>): string | null {
  const parts: string[] = [];
  if (r.kind !== 'exclusion') parts.push('Roja');
  if (r.durationMs !== REDUCTION_MS) parts.push(`${r.durationMs / 60_000}'`);
  return parts.length ? parts.join(' ') : null;
}
