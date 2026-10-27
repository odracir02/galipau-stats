// Gráficas ligeras (CSS/SVG, sin dependencias). Todas muestran también los
// valores en texto y no dependen solo del color para transmitir información.
import { formatPct } from '../../domain/format';
import type { IntervalStats } from '../../stats/engine';

/** Barra horizontal de porcentaje con su valor y las cifras que lo generan. */
export function Meter({ label, pct, detail }: { label: string; pct: number | null; detail: string }) {
  const text = pct === null ? 'Sin datos' : formatPct(pct);
  return (
    <div className="meter">
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value">
          <strong>{text}</strong> <span className="muted">{detail}</span>
        </span>
      </div>
      <div
        className={pct === null ? 'meter-track is-empty' : 'meter-track'}
        role="img"
        aria-label={`${label}: ${text}, ${detail}`}
      >
        {pct !== null && <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />}
      </div>
    </div>
  );
}

/** Barra de recuento proporcional a un máximo (composición de pérdidas, etc.). */
export function CountBar({ label, count, max }: { label: string; count: number; max: number }) {
  const width = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="countbar">
      <span className="countbar-label">{label}</span>
      <span className="countbar-track" aria-hidden="true">
        <span className="countbar-fill" style={{ width: `${width}%` }} />
      </span>
      <span className="countbar-value">{count}</span>
    </div>
  );
}

/** Indicador circular para el porcentaje principal de una vista. */
export function Ring({ pct, label, size = 88 }: { pct: number | null; label: string; size?: number }) {
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const text = pct === null ? '—' : formatPct(pct);
  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${label}: ${pct === null ? 'sin datos' : text}`}
    >
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      {pct !== null && (
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(shown / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text className="ring-text" x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
        {text}
      </text>
    </svg>
  );
}

/**
 * Evolución por intervalos de 5 minutos: goles a favor hacia arriba y en contra
 * hacia abajo (la dirección, la leyenda y los números identifican cada serie).
 */
export function IntervalChart({ intervals }: { intervals: IntervalStats[] }) {
  const gf = intervals.map((iv) => iv.counters.shots.goals);
  const gc = intervals.map((iv) => iv.counters.gk.goals);
  const max = Math.max(1, ...gf, ...gc);
  const summary = intervals.map((iv, i) => `${iv.endMinute}': ${gf[i]} a favor, ${gc[i]} en contra`).join('; ');
  return (
    <figure className="ichart">
      <div className="ichart-cols" role="img" aria-label={`Goles por intervalos de 5 minutos. ${summary}`}>
        {intervals.map((iv, i) => {
          const halfStart = i > 0 && iv.period !== intervals[i - 1]!.period;
          return (
            <div key={iv.endMinute} className={halfStart ? 'ichart-col is-half-start' : 'ichart-col'}>
              <div className="ichart-up">
                <span className="ichart-bar is-for" style={{ height: `${(gf[i]! / max) * 100}%` }} />
                <span className="ichart-num">{gf[i] || ''}</span>
              </div>
              <span className="ichart-axis">{iv.endMinute}'</span>
              <div className="ichart-down">
                <span className="ichart-bar is-against" style={{ height: `${(gc[i]! / max) * 100}%` }} />
                <span className="ichart-num">{gc[i] || ''}</span>
              </div>
            </div>
          );
        })}
      </div>
      <figcaption className="ichart-legend">
        <span>
          <span className="swatch is-for" aria-hidden="true" /> ▲ Goles a favor
        </span>
        <span>
          <span className="swatch is-against" aria-hidden="true" /> ▼ Goles en contra
        </span>
      </figcaption>
    </figure>
  );
}
