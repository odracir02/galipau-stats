// Evolución partido a partido: una barra por partido finalizado con convocatoria.
// La longitud de la barra es el total registrado (lanzamientos o lanzamientos
// entre palos) con una escala común a los partidos de la misma posición (campo y
// portería, cada una con la suya), y su parte rellena son los
// aciertos (goles o paradas). Las cifras exactas se muestran siempre en texto: el
// gráfico se entiende sin colores. Solo presenta; no calcula ni navega por su cuenta.
import { formatDate, opponentLabel } from '../../domain/format';
import type { Position } from '../../domain/types';
import { evolutionBars, type EvolutionBar, type MyMatchPoint } from './mySeason';

const WHAT: Record<Position, { made: [string, string]; total: [string, string]; empty: string; legend: string; tag: string }> = {
  field: {
    made: ['gol', 'goles'],
    total: ['lanzamiento registrado', 'lanzamientos registrados'],
    empty: 'Sin lanzamientos registrados',
    legend: 'Goles sobre lanzamientos registrados',
    tag: 'Campo',
  },
  goalkeeper: {
    made: ['parada', 'paradas'],
    total: ['lanzamiento entre palos', 'lanzamientos entre palos'],
    empty: 'Sin lanzamientos entre palos registrados',
    legend: 'Paradas sobre lanzamientos recibidos entre palos',
    tag: 'Portero',
  },
};

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;
/** «18/10» (la fecha completa va en el texto accesible). */
const shortDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** Frase completa de un partido, para lectores de pantalla y como nombre del botón. */
function barSentence(b: EvolutionBar, mixed: boolean): string {
  const w = WHAT[b.position];
  const values = b.total === 0 ? w.empty.toLowerCase() : `${plural(b.made, w.made)} de ${plural(b.total, w.total)}`;
  return `${formatDate(b.date)}, ${opponentLabel(b.opponent)}${mixed ? ` (${w.tag.toLowerCase()})` : ''}: ${values}.`;
}

export function EvolutionBars({
  points,
  title,
  onOpen,
}: {
  /** Serie de myMatchSeries/myEvolution: finalizados con convocatoria, en orden cronológico. */
  points: readonly MyMatchPoint[];
  /** Nombre accesible de la lista. */
  title: string;
  /** Si se da, cada partido es un botón que lo abre (la pantalla decide la ruta). */
  onOpen?: (matchId: string) => void;
}) {
  const { bars, scales, mixed } = evolutionBars(points);
  if (bars.length === 0) return null;
  const positions = [...new Set(bars.map((b) => b.position))];
  return (
    <div className="evo">
      <ul className="evo-legend" aria-hidden="true">
        {positions.map((p) => (
          <li key={p}>
            <span className={`evo-swatch evo-${p}`} />
            {WHAT[p].legend}
          </li>
        ))}
      </ul>
      <ol className="evo-list" aria-label={title}>
        {bars.map((b) => {
          const w = WHAT[b.position];
          const body = (
            <>
              <span className="sr-only">{barSentence(b, mixed)}</span>
              <span className="evo-head" aria-hidden="true">
                <span className="evo-date">{shortDate(b.date)}</span>
                <span className="evo-rival">{opponentLabel(b.opponent)}</span>
                {mixed && <span className="evo-tag">{w.tag}</span>}
                {b.total > 0 && <span className="evo-value">{`${b.made} de ${b.total}`}</span>}
              </span>
              {b.total > 0 ? (
                <span className="evo-track" aria-hidden="true" style={{ width: `${(b.total / scales[b.position]) * 100}%` }}>
                  <span className={`evo-fill evo-${b.position}`} style={{ width: `${(b.made / b.total) * 100}%` }} />
                </span>
              ) : (
                // Sin total no hay barra: el aviso ocupa su lugar (el rival sigue visible).
                <span className="evo-empty" aria-hidden="true">
                  {w.empty}
                </span>
              )}
            </>
          );
          return (
            <li key={b.matchId}>
              {onOpen ? (
                <button type="button" className="evo-row" onClick={() => onOpen(b.matchId)}>
                  {body}
                </button>
              ) : (
                <div className="evo-row">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
