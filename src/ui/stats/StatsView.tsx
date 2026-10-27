import { useState, type ReactNode } from 'react';
import { formatPct } from '../../domain/format';
import {
  efficiency,
  sanctions,
  savePct,
  type Counters,
  type IntervalStats,
} from '../../stats/engine';
import { Segmented } from '../components/Segmented';
import { PlayerCard } from './PlayerCard';
import { GkSummary, GkTypeTable, KV, RedsValue, ShotTypeTable, Tile, type StatRow } from './StatTables';

interface Props {
  team: Counters;
  rows: StatRow[];
  intervals: IntervalStats[] | null;
  /** Bloque superior de la pestaña Equipo (marcador o resumen de temporada). */
  summary: ReactNode;
  pendingCount: number;
  mode: 'match' | 'season';
}

type Tab = 'team' | 'players' | 'goalkeepers';

export function StatsView({ team, rows, intervals, summary, pendingCount, mode }: Props) {
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
      {tab === 'players' && <PlayerTable rows={fieldRows} mode={mode} onOpen={setOpen} />}
      {tab === 'goalkeepers' && <GoalkeeperTable rows={gkRows} mode={mode} onOpen={setOpen} />}
      {open && <PlayerCard row={open} mode={mode} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TeamStats({ team, intervals, summary }: { team: Counters; intervals: IntervalStats[] | null; summary: ReactNode }) {
  const misses = team.shots.out + team.shots.saved;
  return (
    <>
      {summary}
      <div className="tiles">
        <Tile
          accent
          label="Eficacia"
          value={formatPct(efficiency(team.shots))}
          sub={`${team.shots.goals}/${team.shots.attempts}`}
        />
        <Tile label="% paradas" value={formatPct(savePct(team.gk))} sub={`${team.gk.saves}/${team.gk.saves + team.gk.goals}`} />
        <Tile label="Pérd. / Rec." value={`${team.turnovers.total} / ${team.recoveries}`} />
      </div>
      <section className="card">
        <h3>Ataque</h3>
        <dl className="kv">
          <KV k="Goles" v={team.shots.goals} />
          <KV k="Fallos (fuera + parados)" v={misses} />
          <KV k="Lanzamientos" v={team.shots.attempts} />
          <KV k="Eficacia" v={formatPct(efficiency(team.shots))} strong />
          <KV k="Pasos" v={team.turnovers.steps} />
          <KV k="Dobles" v={team.turnovers.double} />
          <KV k="Pases fallados" v={team.turnovers.badPass} />
          <KV k="Otras pérdidas" v={team.turnovers.general} />
          <KV k="Pérdidas de balón (total)" v={team.turnovers.total} strong />
        </dl>
      </section>
      <section className="card">
        <h3>Lanzamientos por tipo</h3>
        <ShotTypeTable counters={team} />
      </section>
      <section className="card">
        <h3>Defensa</h3>
        <dl className="kv">
          <KV k="Amarillas" v={team.yellows} />
          <KV k="Exclusiones" v={team.exclusions} />
          <KV k="Expulsiones (rojas)" v={<RedsValue counters={team} />} />
          <KV k="Sanciones (total)" v={sanctions(team)} strong />
          <KV k="Recuperaciones" v={team.recoveries} />
          <KV k="Golpes francos" v={team.freeThrows} />
          <KV k="Penaltis cometidos" v={team.penaltiesCommitted} />
        </dl>
      </section>
      <section className="card">
        <h3>Portería</h3>
        <GkSummary counters={team} />
        <GkTypeTable counters={team} />
      </section>
      {intervals && (
        <section className="card">
          <h3>Por intervalos de 5 minutos</h3>
          <IntervalTable intervals={intervals} />
        </section>
      )}
    </>
  );
}

function IntervalTable({ intervals }: { intervals: IntervalStats[] }) {
  return (
    <div className="table-scroll">
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
          {intervals.map((iv) => (
            <tr key={iv.endMinute} className={iv.endMinute === 30 ? 'row-split' : undefined}>
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
      <p className="hint">GF/GC: goles registrados con acción (no incluyen correcciones manuales del marcador).</p>
    </div>
  );
}

interface TableProps {
  rows: StatRow[];
  mode: 'match' | 'season';
  onOpen: (row: StatRow) => void;
}

function PlayerTable({ rows, mode, onOpen }: TableProps) {
  if (rows.length === 0) return <p className="empty">Sin jugadores de campo.</p>;
  return (
    <>
      <div className="card table-card">
        <div className="table-scroll">
          <table className="table table-tap">
            <thead>
              <tr>
                <th>Jugador</th>
                {mode === 'season' && <th title="Partidos convocado">PJ</th>}
                <th title="Goles / lanzamientos">G/L</th>
                <th>Efic.</th>
                <th title="Pérdidas">Pérd.</th>
                <th title="Recuperaciones">Rec.</th>
                <th title="Sanciones">Sanc.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.playerId} onClick={() => onOpen(r)}>
                  <th scope="row">
                    <span className="dorsal">{r.number}</span> {r.name}
                  </th>
                  {mode === 'season' && <td>{r.matches}</td>}
                  <td className="em">
                    {r.counters.shots.goals}/{r.counters.shots.attempts}
                  </td>
                  <td>{formatPct(efficiency(r.counters.shots))}</td>
                  <td>{r.counters.turnovers.total}</td>
                  <td>{r.counters.recoveries}</td>
                  <td>{sanctions(r.counters)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint">Toca un jugador para ver su ficha completa.</p>
    </>
  );
}

function GoalkeeperTable({ rows, mode, onOpen }: TableProps) {
  if (rows.length === 0) return <p className="empty">Sin porteros.</p>;
  // La columna de goles solo aparece si algún portero ha lanzado (p. ej. a portería vacía).
  const anyShots = rows.some((r) => r.counters.shots.attempts > 0);
  return (
    <>
      <div className="card table-card">
        <div className="table-scroll">
          <table className="table table-tap">
            <thead>
              <tr>
                <th>Portero</th>
                {mode === 'season' && <th title="Partidos convocado">PJ</th>}
                <th title="Paradas">Par.</th>
                <th title="Goles encajados">GC</th>
                <th>Fuera</th>
                <th>% par.</th>
                {anyShots && <th title="Goles marcados / lanzamientos">G/L</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.playerId} onClick={() => onOpen(r)}>
                  <th scope="row">
                    <span className="dorsal">{r.number}</span> {r.name}
                  </th>
                  {mode === 'season' && <td>{r.matches}</td>}
                  <td>{r.counters.gk.saves}</td>
                  <td>{r.counters.gk.goals}</td>
                  <td>{r.counters.gk.out}</td>
                  <td className="em">{formatPct(savePct(r.counters.gk))}</td>
                  {anyShots && (
                    <td>
                      {r.counters.shots.goals}/{r.counters.shots.attempts}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint">% paradas = paradas / (paradas + goles). Los lanzamientos fuera no cuentan.</p>
    </>
  );
}
