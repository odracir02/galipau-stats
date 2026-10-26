import { formatPct } from '../../domain/format';
import { efficiency, perMatch, sanctions } from '../../stats/engine';
import { Sheet } from '../components/Sheet';
import { GkSummary, GkTypeTable, KV, ShotTypeTable, type StatRow } from './StatTables';

const avg = (value: number | null) =>
  value === null ? '—' : value.toLocaleString('es-ES', { maximumFractionDigits: 1 });

/** Ficha individual con TODAS las estadísticas registradas del jugador. */
export function PlayerCard({ row, mode, onClose }: { row: StatRow; mode: 'match' | 'season'; onClose: () => void }) {
  const c = row.counters;
  const isGk = row.position === 'goalkeeper';
  return (
    <Sheet title={`${row.number} · ${row.name}`} onClose={onClose}>
      <p className="muted">
        {isGk ? 'Portero' : 'Jugador de campo'}
        {mode === 'season' && ` · ${row.matches ?? 0} partidos convocado`}
      </p>

      {isGk ? (
        <section className="card">
          <h3>Portería</h3>
          <GkSummary counters={c} />
          {mode === 'season' && (
            <dl className="kv">
              <KV k="Paradas por partido" v={avg(perMatch(c.gk.saves, row.matches ?? 0))} />
              <KV k="Goles encajados por partido" v={avg(perMatch(c.gk.goals, row.matches ?? 0))} />
            </dl>
          )}
          <GkTypeTable counters={c} />
        </section>
      ) : (
        <section className="card">
          <h3>Lanzamientos</h3>
          <dl className="kv">
            <KV k="Goles" v={c.shots.goals} />
            <KV k="Fuera" v={c.shots.out} />
            <KV k="Parados" v={c.shots.saved} />
            <KV k="Lanzamientos" v={c.shots.attempts} />
            <KV k="Eficacia" v={formatPct(efficiency(c.shots))} strong />
            {mode === 'season' && <KV k="Goles por partido" v={avg(perMatch(c.shots.goals, row.matches ?? 0))} />}
          </dl>
          <ShotTypeTable counters={c} />
        </section>
      )}

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
          <KV k="Rojas" v={c.reds} />
          <KV k="Sanciones (total)" v={sanctions(c)} strong />
          <KV k="Golpes francos" v={c.freeThrows} />
          <KV k="Penaltis cometidos" v={c.penaltiesCommitted} />
        </dl>
      </section>
    </Sheet>
  );
}
