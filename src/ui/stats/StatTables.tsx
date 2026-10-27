// Bloques de estadísticas compartidos por la vista de equipo y las fichas. Solo
// presentan cifras del motor estadístico; no calculan nada que no exista allí.
import type { ReactNode } from 'react';
import {
  FIELD_SHOT_TYPE_LABEL,
  FIELD_SHOT_TYPE_SHORT,
  FIELD_SHOT_TYPES,
  GK_SHOT_TYPE_LABEL,
  GK_SHOT_TYPE_SHORT,
  GK_SHOT_TYPES,
} from '../../domain/catalog';
import { formatClock, formatPct } from '../../domain/format';
import type { Id, Position } from '../../domain/types';
import type { RedCard } from '../../stats/discipline';
import { efficiency, onTarget, sanctions, savePct, type Counters } from '../../stats/engine';
import { CountBar, Meter } from './charts';

export interface StatRow {
  playerId: Id;
  number: number;
  name: string;
  position: Position;
  /** Partidos con convocatoria registrada (solo en temporada). */
  matches?: number;
  counters: Counters;
}

export function KV({ k, v, strong }: { k: string; v: ReactNode; strong?: boolean }) {
  return (
    <div className={strong ? 'kv-row strong' : 'kv-row'}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

/** Cifra clave destacada. */
export function Tile({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: string; accent?: boolean }) {
  return (
    <div className={accent ? 'tile tile-accent' : 'tile'}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">
        {label}
        {sub && <span className="tile-sub"> · {sub}</span>}
      </span>
    </div>
  );
}

/** Número de rojas con su origen: «1 · por acumulación», «2 · 1 directa, 1 por acumulación». */
export function RedsValue({ counters: c }: { counters: Counters }) {
  if (c.reds === 0) return <>0</>;
  const parts: string[] = [];
  if (c.redsDirect) parts.push(`${c.redsDirect} ${c.redsDirect === 1 ? 'directa' : 'directas'}`);
  if (c.redsAccumulated) parts.push(`${c.redsAccumulated} por acumulación`);
  const detail = parts.length === 1 ? parts[0]!.replace(/^\d+ /, '') : parts.join(', ');
  return (
    <>
      {c.reds} <span className="muted">· {detail}</span>
    </>
  );
}

/** Desplegable con las cifras exactas (tablas), cerrado por defecto. */
export function Exact({ summary = 'Ver cifras exactas', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="exact">
      <summary>{summary}</summary>
      <div className="table-scroll">{children}</div>
    </details>
  );
}

/** Lanzamientos propios: barras de eficacia por tipo + tabla exacta. */
export function ShotsBlock({ counters: c }: { counters: Counters }) {
  return (
    <>
      <div className="meters">
        {FIELD_SHOT_TYPES.map((t) => {
          const line = c.shotsByType[t];
          return (
            <Meter
              key={t}
              label={FIELD_SHOT_TYPE_LABEL[t]}
              pct={efficiency(line)}
              detail={`${line.goals}/${line.attempts}`}
            />
          );
        })}
      </div>
      <Exact>
        <table className="table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Gol</th>
              <th>Fuera</th>
              <th>Parada</th>
              <th>Total</th>
              <th>Efic.</th>
            </tr>
          </thead>
          <tbody>
            {FIELD_SHOT_TYPES.map((t) => {
              const line = c.shotsByType[t];
              return (
                <tr key={t}>
                  <th scope="row">{FIELD_SHOT_TYPE_SHORT[t]}</th>
                  <td>{line.goals}</td>
                  <td>{line.out}</td>
                  <td>{line.saved}</td>
                  <td>{line.attempts}</td>
                  <td>{formatPct(efficiency(line))}</td>
                </tr>
              );
            })}
            <tr className="row-total">
              <th scope="row">Total</th>
              <td>{c.shots.goals}</td>
              <td>{c.shots.out}</td>
              <td>{c.shots.saved}</td>
              <td>{c.shots.attempts}</td>
              <td>{formatPct(efficiency(c.shots))}</td>
            </tr>
          </tbody>
        </table>
      </Exact>
    </>
  );
}

/**
 * Portería: resumen, barras de % paradas por procedencia y tabla exacta.
 * `summary={false}` omite el resumen cuando ya se muestra en otra parte (ficha).
 */
export function GoalkeepingBlock({ counters: c, summary = true }: { counters: Counters; summary?: boolean }) {
  const gk = c.gk;
  return (
    <>
      {summary && (
        <div className="mini-stats">
          <div>
            <strong>{gk.received}</strong>
            <span>Recibidos</span>
          </div>
          <div>
            <strong>{gk.goals}</strong>
            <span>Goles encajados</span>
          </div>
          <div>
            <strong>{gk.saves}</strong>
            <span>Paradas</span>
          </div>
          <div>
            <strong>{gk.out}</strong>
            <span>Fuera</span>
          </div>
        </div>
      )}
      <div className="meters">
        {GK_SHOT_TYPES.map((t) => {
          const line = c.gkByType[t];
          return (
            <Meter
              key={t}
              label={GK_SHOT_TYPE_LABEL[t]}
              pct={savePct(line)}
              detail={`${line.saves}/${onTarget(line)}`}
            />
          );
        })}
      </div>
      <p className="hint">% paradas = paradas / (paradas + goles). Los lanzamientos fuera no cuentan.</p>
      <Exact>
        <table className="table">
          <thead>
            <tr>
              <th>Procedencia</th>
              <th>Gol</th>
              <th>Par.</th>
              <th>Fuera</th>
              <th>Total</th>
              <th>% par.</th>
            </tr>
          </thead>
          <tbody>
            {GK_SHOT_TYPES.map((t) => {
              const line = c.gkByType[t];
              return (
                <tr key={t}>
                  <th scope="row">{GK_SHOT_TYPE_SHORT[t]}</th>
                  <td>{line.goals}</td>
                  <td>{line.saves}</td>
                  <td>{line.out}</td>
                  <td>{line.received}</td>
                  <td>{formatPct(savePct(line))}</td>
                </tr>
              );
            })}
            <tr className="row-total">
              <th scope="row">Total</th>
              <td>{gk.goals}</td>
              <td>{gk.saves}</td>
              <td>{gk.out}</td>
              <td>{gk.received}</td>
              <td>{formatPct(savePct(gk))}</td>
            </tr>
          </tbody>
        </table>
      </Exact>
    </>
  );
}

/** Balance de balón: pérdidas (con su composición) frente a recuperaciones. */
export function BallBlock({ counters: c }: { counters: Counters }) {
  const t = c.turnovers;
  return (
    <>
      <div className="mini-stats mini-stats-2">
        <div>
          <strong>{t.total}</strong>
          <span>Pérdidas</span>
        </div>
        <div>
          <strong>{c.recoveries}</strong>
          <span>Recuperaciones</span>
        </div>
      </div>
      <div className="countbars">
        <CountBar label="Pasos" count={t.steps} max={t.total} />
        <CountBar label="Dobles" count={t.double} max={t.total} />
        <CountBar label="Pases fallados" count={t.badPass} max={t.total} />
        <CountBar label="Otras pérdidas" count={t.general} max={t.total} />
      </div>
    </>
  );
}

/** Disciplina y defensa. `card` añade el momento de la descalificación (vista de partido). */
export function DisciplineBlock({ counters: c, card }: { counters: Counters; card?: RedCard }) {
  return (
    <dl className="kv">
      <KV k="Amarillas" v={c.yellows} />
      <KV k="Exclusiones 2 min" v={c.exclusions} />
      <KV k="Rojas" v={<RedsValue counters={c} />} />
      {card && (
        <KV
          k="Descalificación"
          v={`${card.type === 'direct' ? 'Roja directa' : '3.ª exclusión'} · ${formatClock(card.matchTimeMs)}`}
        />
      )}
      <KV k="Sanciones (total)" v={sanctions(c)} strong />
      <KV k="Penaltis cometidos" v={c.penaltiesCommitted} />
    </dl>
  );
}
