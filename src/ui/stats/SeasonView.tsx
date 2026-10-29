// Estadísticas de temporada (equipo, jugadores y porteros) con filtros de
// temporada y «Solo finalizados». La usan el equipo del dispositivo y la consulta
// de equipos del club.
import { ChevronRight, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { computeSeasonStats, perMatch, type MatchWithEvents } from '../../stats/engine';
import { Icon } from '../components/Icon';
import { StatsView } from './StatsView';
import { Tile } from './StatTables';

/**
 * Estadísticas de temporada de un equipo a partir de sus partidos (los del
 * dispositivo o los descargados del club). Solo presenta: no lee ni escribe datos.
 */
export function SeasonView({
  items: all,
  defaultSeason,
  onRankings,
}: {
  items: readonly MatchWithEvents[];
  defaultSeason: string;
  onRankings: () => void;
}) {
  const seasons = useMemo(() => {
    const set = new Set(all.map((i) => i.match.season));
    set.add(defaultSeason);
    return [...set].sort().reverse();
  }, [all, defaultSeason]);
  const [season, setSeason] = useState(defaultSeason);
  const [onlyFinished, setOnlyFinished] = useState(false);

  const items = useMemo(
    () => all.filter((i) => i.match.season === season && (!onlyFinished || i.match.status === 'finished')),
    [all, season, onlyFinished],
  );
  const stats = useMemo(() => computeSeasonStats(items), [items]);
  const rows = [...stats.players.values()]
    .map((p) => ({ ...p.latest, matches: p.matches, counters: p.counters }))
    .sort((a, b) => a.number - b.number);
  const avg = (v: number | null) => (v === null ? '—' : v.toLocaleString('es-ES', { maximumFractionDigits: 1 }));

  return (
    <>
      <div className="filters">
        <label>
          Temporada
          <select value={season} onChange={(e) => setSeason(e.target.value)}>
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyFinished} onChange={(e) => setOnlyFinished(e.target.checked)} />
          Solo finalizados
        </label>
      </div>
      <button type="button" className="list-item rank-link" onClick={onRankings}>
        <span className="rank-link-icon">
          <Icon as={Trophy} />
        </span>
        <span className="list-main">
          <strong>Rankings</strong>
          <span className="muted">Pistolero, francotirador, el muro…</span>
        </span>
        <Icon as={ChevronRight} className="chevron" />
      </button>
      {stats.matches === 0 ? (
        <p className="empty">No hay partidos registrados en esta temporada.</p>
      ) : (
        <StatsView
          mode="season"
          context={`Temporada ${season}`}
          team={stats.team}
          rows={rows}
          intervals={stats.intervals}
          pendingCount={stats.pendingCount}
          summary={
            <>
              <div className="tiles tiles-3">
                <Tile label="Partidos" value={stats.matches} />
                <Tile
                  label="A favor"
                  value={stats.goalsFor}
                  sub={`${avg(perMatch(stats.goalsFor, stats.matches))}/p`}
                />
                <Tile
                  label="En contra"
                  value={stats.goalsAgainst}
                  sub={`${avg(perMatch(stats.goalsAgainst, stats.matches))}/p`}
                />
              </div>
              <p className="hint">
                Goles a favor y en contra incluyen las correcciones manuales del marcador; el resto de cifras, solo las
                acciones registradas.
              </p>
            </>
          }
        />
      )}
    </>
  );
}
