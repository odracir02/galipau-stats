import { formatPct } from '../../domain/format';
import type { Counters } from '../../stats/engine';
import { efficiency, perMatch, sanctions, savePct } from '../../stats/engine';
import { Sheet } from '../components/Sheet';
import { GkSummary, GkTypeTable, KV, RedsValue, ShotTypeTable, Tile, type StatRow } from './StatTables';

const avg = (value: number | null) =>
  value === null ? '—' : value.toLocaleString('es-ES', { maximumFractionDigits: 1 });

/** Ficha individual con TODAS las estadísticas registradas del jugador. */
export function PlayerCard({ row, mode, onClose }: { row: StatRow; mode: 'match' | 'season'; onClose: () => void }) {
  const c = row.counters;
  const isGk = row.position === 'goalkeeper';
  const matches = row.matches ?? 0;
  // Un portero solo muestra lanzamientos propios si los tiene (p. ej. gol a portería vacía).
  const showShots = !isGk || c.shots.attempts > 0;

  return (
    <Sheet title={row.name} onClose={onClose}>
      <div className="player-head">
        <span className="dorsal dorsal-lg">{row.number}</span>
        <span className="muted">
          {isGk ? 'Portero' : 'Jugador de campo'}
          {mode === 'season' && ` · ${matches} ${matches === 1 ? 'partido convocado' : 'partidos convocado'}`}
        </span>
      </div>

      <div className="tiles">
        {isGk ? (
          <>
            <Tile accent label="% paradas" value={formatPct(savePct(c.gk))} />
            <Tile label="Paradas" value={c.gk.saves} />
            <Tile label="Goles encajados" value={c.gk.goals} />
          </>
        ) : (
          <>
            <Tile accent label="Eficacia" value={formatPct(efficiency(c.shots))} />
            <Tile label="Goles" value={c.shots.goals} sub={`${c.shots.attempts} lanz.`} />
            <Tile label="Pérd. / Rec." value={`${c.turnovers.total} / ${c.recoveries}`} />
          </>
        )}
      </div>

      {isGk && (
        <section className="card">
          <h3>Portería</h3>
          <GkSummary counters={c} />
          {mode === 'season' && (
            <dl className="kv">
              <KV k="Paradas por partido" v={avg(perMatch(c.gk.saves, matches))} />
              <KV k="Goles encajados por partido" v={avg(perMatch(c.gk.goals, matches))} />
            </dl>
          )}
          <GkTypeTable counters={c} />
        </section>
      )}

      {showShots && <ShotsSection counters={c} season={mode === 'season'} matches={matches} />}

      <section className="card">
        <h3>Pérdidas y recuperaciones</h3>
        <dl className="kv">
          <KV k="Pasos" v={c.turnovers.steps} />
          <KV k="Dobles" v={c.turnovers.double} />
          <KV k="Pases fallados" v={c.turnovers.badPass} />
          <KV k="Otras pérdidas" v={c.turnovers.general} />
          <KV k="Pérdidas (total)" v={c.turnovers.total} strong />
          <KV k="Recuperaciones" v={c.recoveries} strong />
        </dl>
      </section>

      <section className="card">
        <h3>Defensa y sanciones</h3>
        <dl className="kv">
          <KV k="Amarillas" v={c.yellows} />
          <KV k="Exclusiones 2 min" v={c.exclusions} />
          <KV k="Rojas" v={<RedsValue counters={c} />} />
          <KV k="Sanciones (total)" v={sanctions(c)} strong />
          <KV k="Golpes francos" v={c.freeThrows} />
          <KV k="Penaltis cometidos" v={c.penaltiesCommitted} />
        </dl>
      </section>
    </Sheet>
  );
}

function ShotsSection({ counters: c, season, matches }: { counters: Counters; season: boolean; matches: number }) {
  return (
    <section className="card">
      <h3>Lanzamientos</h3>
      <dl className="kv">
        <KV k="Goles" v={c.shots.goals} />
        <KV k="Fuera" v={c.shots.out} />
        <KV k="Parados" v={c.shots.saved} />
        <KV k="Lanzamientos" v={c.shots.attempts} />
        <KV k="Eficacia" v={formatPct(efficiency(c.shots))} strong />
        {season && <KV k="Goles por partido" v={avg(perMatch(c.shots.goals, matches))} />}
      </dl>
      <ShotTypeTable counters={c} />
    </section>
  );
}
