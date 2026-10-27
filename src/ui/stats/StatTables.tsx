import type { ReactNode } from 'react';
import { FIELD_SHOT_TYPE_LABEL, FIELD_SHOT_TYPES, GK_SHOT_TYPE_LABEL, GK_SHOT_TYPES } from '../../domain/catalog';
import { formatPct } from '../../domain/format';
import type { Id, Position } from '../../domain/types';
import { efficiency, onTarget, savePct, type Counters } from '../../stats/engine';

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

export function ShotTypeTable({ counters }: { counters: Counters }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Tipo</th>
          <th>Gol</th>
          <th>Fuera</th>
          <th>Parada</th>
          <th>Efic.</th>
        </tr>
      </thead>
      <tbody>
        {FIELD_SHOT_TYPES.map((t) => {
          const line = counters.shotsByType[t];
          return (
            <tr key={t}>
              <th scope="row">{FIELD_SHOT_TYPE_LABEL[t]}</th>
              <td>{line.goals}</td>
              <td>{line.out}</td>
              <td>{line.saved}</td>
              <td>{formatPct(efficiency(line))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function GkSummary({ counters }: { counters: Counters }) {
  const gk = counters.gk;
  return (
    <dl className="kv">
      <KV k="Lanzamientos recibidos" v={gk.received} />
      <KV k="Goles encajados" v={gk.goals} />
      <KV k="Paradas" v={gk.saves} />
      <KV k="Fuera" v={gk.out} />
      <KV k="Entre los tres palos" v={onTarget(gk)} />
      <KV k="% paradas" v={formatPct(savePct(gk))} strong />
    </dl>
  );
}

export function GkTypeTable({ counters }: { counters: Counters }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Procedencia</th>
          <th>Gol</th>
          <th>Par.</th>
          <th>Fuera</th>
          <th>% par.</th>
        </tr>
      </thead>
      <tbody>
        {GK_SHOT_TYPES.map((t) => {
          const line = counters.gkByType[t];
          return (
            <tr key={t}>
              <th scope="row">{GK_SHOT_TYPE_LABEL[t]}</th>
              <td>{line.goals}</td>
              <td>{line.saves}</td>
              <td>{line.out}</td>
              <td>{formatPct(savePct(line))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Cifra clave destacada (eficacia, % paradas…). */
export function Tile({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: string; accent?: boolean }) {
  return (
    <div className={accent ? 'tile tile-accent' : 'tile'}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">
        {label}
        {sub && ` · ${sub}`}
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
