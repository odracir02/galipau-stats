import type { ReactNode } from 'react';
import type { RedCard } from '../../stats/discipline';
import { efficiency, perMatch, savePct, type Counters } from '../../stats/engine';
import { Sheet } from '../components/Sheet';
import { Meter, Ring } from './charts';
import { BallBlock, DisciplineBlock, GoalkeepingBlock, KV, ShotsBlock, Tile, type StatRow } from './StatTables';

const avg = (value: number | null) =>
  value === null ? '—' : value.toLocaleString('es-ES', { maximumFractionDigits: 1 });

interface Props {
  row: StatRow;
  mode: 'match' | 'season';
  /** «vs Rival · 27/10/2026» o «Temporada 2026/27». */
  context: string;
  /** Descalificación en este partido (solo vista de partido). */
  card?: RedCard;
  onClose: () => void;
}

/** Ficha individual con TODAS las estadísticas registradas del jugador o portero. */
export function PlayerCard({ row, mode, context, card, onClose }: Props) {
  const c = row.counters;
  const isGk = row.position === 'goalkeeper';
  const matches = row.matches ?? 0;
  const s = c.shots;

  return (
    <Sheet title={isGk ? 'Ficha del portero' : 'Ficha del jugador'} onClose={onClose}>
      <header className="pcard-head">
        <span className="pcard-num">{row.number}</span>
        <div>
          <strong>{row.name}</strong>
          <span className="muted">
            {isGk ? 'Portero' : 'Jugador de campo'} · {context}
            {mode === 'season' && ` · ${matches} ${matches === 1 ? 'partido' : 'partidos'}`}
          </span>
        </div>
      </header>

      {isGk ? (
        <>
          <section className="card">
            <div className="hero">
              <Ring pct={savePct(c.gk)} label="Porcentaje de paradas" />
              <div className="hero-text">
                <span className="hero-label">% paradas</span>
                <strong>
                  {c.gk.saves} {c.gk.saves === 1 ? 'parada' : 'paradas'} / {c.gk.saves + c.gk.goals} entre palos
                </strong>
                <span className="muted">
                  {c.gk.out} {c.gk.out === 1 ? 'lanzamiento fuera' : 'lanzamientos fuera'}
                </span>
              </div>
            </div>
            <div className="tiles">
              <Tile label="Paradas" value={c.gk.saves} />
              <Tile label="Goles encajados" value={c.gk.goals} />
              <Tile label="Recibidos" value={c.gk.received} />
              <Tile label="Fuera" value={c.gk.out} />
            </div>
          </section>
          <Block title="Portería por procedencia">
            <GoalkeepingBlock counters={c} summary={false} />
          </Block>
          {s.attempts > 0 && (
            <Block title="Lanzamientos propios">
              <Meter label="Eficacia" pct={efficiency(s)} detail={`${s.goals}/${s.attempts}`} />
              <ShotsBlock counters={c} />
            </Block>
          )}
        </>
      ) : (
        <>
          <section className="card">
            <div className="hero">
              <Ring pct={efficiency(s)} label="Eficacia" />
              <div className="hero-text">
                <span className="hero-label">Eficacia</span>
                <strong>
                  {s.goals} {s.goals === 1 ? 'gol' : 'goles'} / {s.attempts}{' '}
                  {s.attempts === 1 ? 'lanzamiento' : 'lanzamientos'}
                </strong>
                <span className="muted">
                  {s.out} fuera · {s.saved} {s.saved === 1 ? 'parado' : 'parados'} por el portero rival
                </span>
              </div>
            </div>
            <div className="tiles">
              <Tile label="Goles" value={s.goals} />
              <Tile label="Lanzamientos" value={s.attempts} />
            </div>
          </section>
          <Block title="Lanzamientos por tipo">
            <ShotsBlock counters={c} />
          </Block>
        </>
      )}

      <Block title="Balance de balón">
        <BallBlock counters={c} />
      </Block>

      <Block title="Disciplina y defensa">
        <DisciplineBlock counters={c} card={card} />
      </Block>

      {mode === 'season' && <SeasonAverages counters={c} matches={matches} isGk={isGk} />}
    </Sheet>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Promedios por partido convocado (solo los que se pueden calcular con los eventos). */
function SeasonAverages({ counters: c, matches, isGk }: { counters: Counters; matches: number; isGk: boolean }) {
  return (
    <Block title="Promedios por partido">
      <dl className="kv">
        <KV k="Partidos con convocatoria" v={matches} strong />
        {isGk ? (
          <>
            <KV k="Paradas" v={avg(perMatch(c.gk.saves, matches))} />
            <KV k="Goles encajados" v={avg(perMatch(c.gk.goals, matches))} />
            <KV k="Lanzamientos recibidos" v={avg(perMatch(c.gk.received, matches))} />
          </>
        ) : (
          <>
            <KV k="Goles" v={avg(perMatch(c.shots.goals, matches))} />
            <KV k="Lanzamientos" v={avg(perMatch(c.shots.attempts, matches))} />
          </>
        )}
        <KV k="Pérdidas" v={avg(perMatch(c.turnovers.total, matches))} />
        <KV k="Recuperaciones" v={avg(perMatch(c.recoveries, matches))} />
        <KV k="Exclusiones" v={avg(perMatch(c.exclusions, matches))} />
      </dl>
    </Block>
  );
}
