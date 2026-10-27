// Panel de estadísticas (partido o temporada): equipo, jugadores y porteros.
// Solo presenta cifras del motor estadístico; los porcentajes sin datos se
// muestran como «Sin datos», nunca como 0 %.
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { formatPct } from '../../domain/format';
import type { Id } from '../../domain/types';
import type { RedCard } from '../../stats/discipline';
import { efficiency, sanctions, savePct, type Counters, type IntervalStats } from '../../stats/engine';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { IntervalChart, Meter, Ring } from './charts';
import { PlayerCard } from './PlayerCard';
import {
  BallBlock,
  DisciplineBlock,
  Exact,
  GoalkeepingBlock,
  ShotsBlock,
  Tile,
  type StatRow,
} from './StatTables';

interface Props {
  team: Counters;
  rows: StatRow[];
  intervals: IntervalStats[] | null;
  /** Bloque superior de la pestaña Equipo (marcador o resumen de temporada). */
  summary: ReactNode;
  pendingCount: number;
  mode: 'match' | 'season';
  /** Contexto que se muestra en las fichas («vs Rival · 27/10/2026», «Temporada 2026/27»). */
  context: string;
  /** Descalificaciones del partido (solo en vista de partido), para indicar su momento. */
  redCards?: ReadonlyMap<Id, RedCard>;
}

type Tab = 'team' | 'players' | 'goalkeepers';

export function StatsView({ team, rows, intervals, summary, pendingCount, mode, context, redCards }: Props) {
  const [tab, setTab] = useState<Tab>('team');
  const [open, setOpen] = useState<StatRow | null>(null);
  const fieldRows = rows.filter((r) => r.position === 'field');
  const gkRows = rows.filter((r) => r.position === 'goalkeeper');

  return (
    <div className="stats">
      <Segmented
        ariaLabel="Sección de estadísticas"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'team', label: 'Equipo' },
          { value: 'players', label: 'Jugadores' },
          { value: 'goalkeepers', label: 'Porteros' },
        ]}
      />
      {pendingCount > 0 && (
        <p className="notice">
          {pendingCount} {pendingCount === 1 ? 'acción pendiente' : 'acciones pendientes'} de atribuir: cuentan en el
          equipo, pero en ningún jugador.
        </p>
      )}
      {tab === 'team' && <TeamStats team={team} intervals={intervals} summary={summary} />}
      {tab === 'players' && <PlayerList rows={fieldRows} mode={mode} onOpen={setOpen} />}
      {tab === 'goalkeepers' && <GoalkeeperList rows={gkRows} mode={mode} onOpen={setOpen} />}
      {open && (
        <PlayerCard
          row={open}
          mode={mode}
          context={context}
          card={redCards?.get(open.playerId)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function TeamStats({
  team,
  intervals,
  summary,
}: {
  team: Counters;
  intervals: IntervalStats[] | null;
  summary: ReactNode;
}) {
  const s = team.shots;
  const hasIntervalData = intervals?.some((iv) => iv.counters.shots.goals + iv.counters.gk.goals > 0) ?? false;
  return (
    <>
      {summary}

      <section className="card">
        <h3>Resumen</h3>
        <div className="hero">
          <Ring pct={efficiency(s)} label="Eficacia ofensiva" />
          <div className="hero-text">
            <span className="hero-label">Eficacia ofensiva</span>
            <strong>
              {s.goals} {s.goals === 1 ? 'gol' : 'goles'} / {s.attempts}{' '}
              {s.attempts === 1 ? 'lanzamiento' : 'lanzamientos'}
            </strong>
            <span className="muted">
              {s.out} fuera · {s.saved} {s.saved === 1 ? 'parado' : 'parados'}
            </span>
          </div>
        </div>
        <div className="tiles">
          <Tile label="Goles" value={s.goals} />
          <Tile label="Lanzamientos" value={s.attempts} />
          <Tile
            accent
            label="% paradas"
            value={formatPct(savePct(team.gk))}
            sub={`${team.gk.saves}/${team.gk.saves + team.gk.goals}`}
          />
          <Tile label="Pérdidas" value={team.turnovers.total} />
          <Tile label="Recuperaciones" value={team.recoveries} />
          <Tile label="Exclusiones · rojas" value={`${team.exclusions} · ${team.reds}`} />
        </div>
      </section>

      <Section title="Lanzamientos por tipo">
        <ShotsBlock counters={team} />
      </Section>

      <Section title="Portería">
        <GoalkeepingBlock counters={team} />
      </Section>

      <Section title="Balance de balón">
        <BallBlock counters={team} />
      </Section>

      <Section title="Disciplina y defensa">
        <DisciplineBlock counters={team} />
      </Section>

      {intervals && (
        <Section title="Evolución por intervalos de 5 minutos">
          {hasIntervalData ? (
            <IntervalChart intervals={intervals} />
          ) : (
            <p className="empty">Todavía no hay goles registrados.</p>
          )}
          <Exact summary="Ver detalle por intervalo">
            <IntervalTable intervals={intervals} />
          </Exact>
          <p className="hint">Solo goles registrados con acción (no incluye correcciones manuales del marcador).</p>
        </Section>
      )}
    </>
  );
}

function IntervalTable({ intervals }: { intervals: IntervalStats[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Hasta</th>
          <th title="Goles a favor">GF</th>
          <th title="Goles en contra">GC</th>
          <th title="Lanzamientos propios">Lanz.</th>
          <th title="Pérdidas">Pérd.</th>
          <th title="Recuperaciones">Rec.</th>
          <th title="Sanciones">Sanc.</th>
        </tr>
      </thead>
      <tbody>
        {intervals.map((iv, i) => (
          <tr key={iv.endMinute} className={i > 0 && iv.period !== intervals[i - 1]!.period ? 'row-half' : undefined}>
            <th scope="row">{iv.endMinute}'</th>
            <td>{iv.counters.shots.goals}</td>
            <td>{iv.counters.gk.goals}</td>
            <td>{iv.counters.shots.attempts}</td>
            <td>{iv.counters.turnovers.total}</td>
            <td>{iv.counters.recoveries}</td>
            <td>{sanctions(iv.counters)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface ListProps {
  rows: StatRow[];
  mode: 'match' | 'season';
  onOpen: (row: StatRow) => void;
}

function RowHead({ r, mode }: { r: StatRow; mode: 'match' | 'season' }) {
  return (
    <span className="prow-who">
      <span className="dorsal">{r.number}</span>
      <span className="prow-name">{r.name}</span>
      {mode === 'season' && <span className="prow-pj">{r.matches} PJ</span>}
    </span>
  );
}

/** Jugadores de campo: una fila por jugador con su eficacia y su balance básico. */
function PlayerList({ rows, mode, onOpen }: ListProps) {
  if (rows.length === 0) return <p className="empty">Sin jugadores de campo.</p>;
  return (
    <>
      <ul className="plist">
        {rows.map((r) => {
          const c = r.counters;
          return (
            <li key={r.playerId}>
              <button type="button" className="prow" onClick={() => onOpen(r)}>
                <span className="prow-top">
                  <RowHead r={r} mode={mode} />
                  <span className="prow-main">
                    <strong>{c.shots.goals}</strong>
                    <span className="muted">/{c.shots.attempts}</span>
                  </span>
                  <Icon as={ChevronRight} size={18} className="chevron" />
                </span>
                <Meter label="Eficacia" pct={efficiency(c.shots)} detail={`${c.shots.goals}/${c.shots.attempts}`} />
                <span className="prow-foot">
                  Pérd. {c.turnovers.total} · Rec. {c.recoveries} · Excl. {c.exclusions}
                  {c.reds > 0 && ' · Roja'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="hint">Toca un jugador para ver su ficha completa.</p>
    </>
  );
}

/** Porteros: % de paradas destacado; goles propios solo si ha lanzado. */
function GoalkeeperList({ rows, mode, onOpen }: ListProps) {
  if (rows.length === 0) return <p className="empty">Sin porteros.</p>;
  return (
    <>
      <ul className="plist">
        {rows.map((r) => {
          const c = r.counters;
          return (
            <li key={r.playerId}>
              <button type="button" className="prow" onClick={() => onOpen(r)}>
                <span className="prow-top">
                  <RowHead r={r} mode={mode} />
                  <span className="prow-main">
                    <strong>{formatPct(savePct(c.gk))}</strong>
                  </span>
                  <Icon as={ChevronRight} size={18} className="chevron" />
                </span>
                <Meter label="% paradas" pct={savePct(c.gk)} detail={`${c.gk.saves}/${c.gk.saves + c.gk.goals}`} />
                <span className="prow-foot">
                  Par. {c.gk.saves} · GC {c.gk.goals} · Fuera {c.gk.out}
                  {c.shots.attempts > 0 && ` · Goles ${c.shots.goals}/${c.shots.attempts}`}
                  {c.reds > 0 && ' · Roja'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="hint">% paradas = paradas / (paradas + goles). Los lanzamientos fuera no cuentan.</p>
    </>
  );
}
