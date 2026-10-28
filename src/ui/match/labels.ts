import { MATCH_STATUS_LABEL } from '../../domain/catalog';
import type { MatchStatus, SquadEntry } from '../../domain/types';
import { matchResult, type MatchResult, type Score } from '../../stats/engine';

export function playerLabel(squad: readonly SquadEntry[], playerId: string | null): string {
  if (playerId === null) return 'Sin asignar';
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
