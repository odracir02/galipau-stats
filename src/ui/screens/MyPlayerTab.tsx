// «Mi jugador» (solo consulta): el jugador que sigue este dispositivo en el
// equipo. La elección es local (ver app/myPlayer.ts): solo su identificador,
// nunca se envía al servidor. Sin elegir a nadie, el equipo se consulta igual.
import { ChevronRight, Radio, Trophy, UserRound } from 'lucide-react';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { myPlayer } from '../../app/remote';
import { openFromTeam } from '../../app/router';
import { showToast } from '../../app/toast';
import type { MyPlayerPreference } from '../../app/myPlayer';
import { isOfficial, MATCH_STATUS_LABEL } from '../../domain/catalog';
import { formatDate, formatPct, opponentLabel } from '../../domain/format';
import type { TeamSnapshot } from '../../remote/api';
import { efficiency, onTarget, savePct, type Counters } from '../../stats/engine';
import { Icon } from '../components/Icon';
import { Ring } from '../stats/charts';
import { EvolutionBars } from '../stats/EvolutionBars';
import { statusBadge } from '../match/labels';
import {
  comparisonAverages,
  liveMatches,
  mainAverage,
  matchLine,
  myEvolution,
  myRankings,
  mySeason,
  otherPositionMatches,
  recentMatches,
  type MyAverage,
  type MyComparison,
  type MyEvolution,
  type MyMatch,
  type MyRanking,
  type MySeason,
} from '../stats/mySeason';
import { RANKING_ICON } from '../stats/rankingIcons';
import { PlayerCard } from '../stats/PlayerCard';
import { Tile } from '../stats/StatTables';

const POSITION_LABEL = { field: 'Jugador de campo', goalkeeper: 'Portero' } as const;

/** Preferencia del equipo, al día con sus cambios (se compara por contenido). */
function usePreference(teamId: string): MyPlayerPreference | null {
  const raw = useSyncExternalStore(
    (l) => myPlayer.subscribe(l),
    () => JSON.stringify(myPlayer.get(teamId)),
  );
  return useMemo(() => JSON.parse(raw) as MyPlayerPreference | null, [raw]);
}

export function MyPlayerTab({ teamId, snapshot, season }: { teamId: string; snapshot: TeamSnapshot; season: string }) {
  const stored = usePreference(teamId);
  // Si el navegador no deja guardarla, la elección vale mientras la pantalla siga abierta.
  const [unsaved, setUnsaved] = useState<MyPlayerPreference | null>(null);
  const preference = unsaved ?? stored;
  const [choosing, setChoosing] = useState(false);
  const [card, setCard] = useState(false);

  // Plantilla que se puede seguir: jugadores y porteros activos, sin el cuerpo técnico.
  const players = useMemo(() => snapshot.players.map((p) => p.player).filter((p) => !isOfficial(p)), [snapshot]);
  const roster = useMemo(() => players.filter((p) => p.active).sort((a, b) => a.number - b.number || a.name.localeCompare(b.name, 'es')), [players]);
  const chosenId = preference && 'playerId' in preference ? preference.playerId : null;
  const chosen = chosenId ? players.find((p) => p.id === chosenId) : undefined;
  // Se recalcula con cada cambio de los datos descargados (directo, «Actualizar»).
  const stats = useMemo(() => (chosen ? mySeason(snapshot, chosen, season) : null), [snapshot, chosen, season]);
  // Recuentos y medias (solo partidos finalizados), con los cálculos de mySeason.ts.
  const evolution = useMemo(() => (chosen ? myEvolution(snapshot, chosen.id, season) : null), [snapshot, chosen, season]);
  // Solo con algún partido en la temporada: sin convocatorias no hay nada que clasificar.
  const rankings = useMemo(
    () => (chosen && stats && stats.matches > 0 ? myRankings(snapshot, chosen.id, stats.row.position, season) : []),
    [snapshot, chosen, stats, season],
  );
  const live = useMemo(() => (chosen ? liveMatches(snapshot, chosen.id) : []), [snapshot, chosen]);
  const recent = useMemo(() => (chosen ? recentMatches(snapshot, chosen.id, season) : []), [snapshot, chosen, season]);

  const save = (pref: MyPlayerPreference) => {
    const ok = 'playerId' in pref ? myPlayer.choose(teamId, pref.playerId) : myPlayer.skip(teamId);
    setUnsaved(ok ? null : pref);
    if (!ok) showToast('Este navegador no deja guardar la elección: se mantiene mientras no cierres la pantalla.', 'info');
    setChoosing(false);
  };

  if (roster.length === 0 && !chosen) {
    return (
      <div className="empty-card">
        <strong>Todavía no hay jugadores en la plantilla</strong>
        <span>Cuando el club los añada, podrás elegir a quién sigues.</span>
      </div>
    );
  }

  // Sin elegir todavía (o el elegido ya no está en los datos): se pregunta, sin obligar.
  const lost = chosenId !== null && !chosen;
  if (choosing || preference === null || lost) {
    return (
      <section className="myplayer-pick" aria-labelledby="myplayer-title">
        {lost && !choosing && <p className="notice">El jugador que seguías ya no está en la plantilla descargada. Puedes elegir a otro.</p>}
        <h2 id="myplayer-title" className="myplayer-title">
          ¿A quién sigues?
        </h2>
        <p className="hint">Se guarda solo en este dispositivo. El club no sabe a quién sigues.</p>
        <ul className="list">
          {roster.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`list-item${p.id === chosenId ? ' myplayer-current' : ''}`}
                aria-pressed={p.id === chosenId}
                onClick={() => save({ playerId: p.id })}
              >
                <span className="dorsal dorsal-lg">{p.number}</span>
                <span className="list-main">
                  <strong>{p.name}</strong>
                  <span className="muted">{POSITION_LABEL[p.position]}</span>
                </span>
                <Icon as={ChevronRight} className="chevron" />
              </button>
            </li>
          ))}
        </ul>
        {choosing ? (
          <button type="button" className="btn btn-block" onClick={() => setChoosing(false)}>
            Cancelar
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-block" onClick={() => save({ skipped: true })}>
            Ahora no
          </button>
        )}
      </section>
    );
  }

  // «Ahora no»: el equipo se consulta igual; se puede elegir cuando se quiera.
  if (!chosen || !stats || !evolution) {
    return (
      <div className="empty-card">
        <Icon as={UserRound} size={28} />
        <strong>No sigues a ningún jugador</strong>
        <span>Puedes consultar el equipo en las demás pestañas.</span>
        <button type="button" className="btn btn-ghost" onClick={() => setChoosing(true)}>
          Elegir jugador
        </button>
      </div>
    );
  }

  return (
    <>
      <section className="card myplayer-head">
        <div className="pcard-head">
          <span className="pcard-num">{chosen.number}</span>
          <div>
            <strong>{chosen.name}</strong>
            <span className="muted">{POSITION_LABEL[chosen.position]}</span>
          </div>
        </div>
        {!chosen.active && <p className="notice">Ahora mismo figura como inactivo en la plantilla del club.</p>}
        <div className="myplayer-actions">
          <button type="button" className="btn" onClick={() => setCard(true)}>
            Ver ficha completa
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setChoosing(true)}>
            Cambiar jugador
          </button>
        </div>
      </section>
      {live.map((m) => (
        <LiveCard key={m.match.id} teamId={teamId} m={m} />
      ))}
      <SeasonSummary stats={stats} evolution={evolution} season={season} />
      {stats.matches > 0 && <Evolution teamId={teamId} evolution={evolution} />}
      {rankings.length > 0 && <RankingsCard teamId={teamId} rankings={rankings} />}
      {recent.length > 0 && <RecentMatches teamId={teamId} matches={recent} />}
      {card && <PlayerCard row={stats.row} mode="season" context={`Temporada ${season}`} onClose={() => setCard(false)} />}
    </>
  );
}

const decimal = (v: number) => v.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** «1,5 de media», solo si hay media (nunca un 0 engañoso). */
const averageSub = (a: MyAverage | null) => (a?.value != null ? `${decimal(a.value)} de media` : undefined);
const POSITION_NAME = { field: 'jugador de campo', goalkeeper: 'portero' } as const;

/**
 * Qué cuenta la media principal: el denominador, con su número. Sin partidos que
 * cuenten, por qué todavía no hay media.
 */
function averageNote(a: MyAverage | null, position: 'field' | 'goalkeeper', finished: number): string {
  const what = position === 'goalkeeper' ? 'paradas' : 'goles';
  if (finished === 0) return `La media de ${what} aparecerá con su primer partido finalizado.`;
  if (!a || a.denominator === 0) {
    return position === 'goalkeeper'
      ? 'Todavía sin media de paradas: no tiene lanzamientos entre palos registrados en partidos finalizados como portero.'
      : 'Todavía sin media de goles: no tiene convocatorias como jugador de campo en partidos finalizados.';
  }
  return position === 'goalkeeper'
    ? `Media de paradas: por partido finalizado con lanzamientos entre palos (${a.denominator}).`
    : `Media de goles: por convocatoria en partido finalizado (${a.denominator}).`;
}

/** Resumen de la temporada: las cifras principales, de un vistazo. El detalle, en la ficha completa. */
function SeasonSummary({ stats, evolution, season }: { stats: MySeason; evolution: MyEvolution; season: string }) {
  const { row, matches, live } = stats;
  const c = row.counters;
  const { counts } = evolution;
  const average = mainAverage(evolution, row.position);
  const other = otherPositionMatches(evolution, row.position);
  if (matches === 0) {
    return (
      <div className="empty-card">
        <strong>Todavía sin partidos esta temporada</strong>
        <span>Sus estadísticas aparecerán cuando figure en la convocatoria de un partido de la temporada {season}.</span>
      </div>
    );
  }
  return (
    <section className="card myplayer-season" aria-label={`Temporada ${season}`}>
      <h3>Temporada {season}</h3>
      {row.position === 'goalkeeper' ? <KeeperSummary c={c} average={average} /> : <FieldSummary c={c} average={average} />}
      <p className="myplayer-counts">
        <span>{count(counts.convocations, 'convocatoria', 'convocatorias')}</span>
        <span>{counts.finished} en partidos finalizados</span>
        <span>{counts.finishedWithActions} con acciones registradas</span>
      </p>
      <p className="hint">
        {averageNote(average, row.position, counts.finished)}
        {other > 0 &&
          ` También ha ido convocado como ${POSITION_NAME[row.position === 'goalkeeper' ? 'field' : 'goalkeeper']} en ${count(other, 'partido', 'partidos')}: la media solo cuenta sus partidos como ${POSITION_NAME[row.position]}.`}
      </p>
      {live > 0 && (
        <p className="hint myplayer-live">
          <Icon as={Radio} size={14} /> Los totales incluyen el partido en juego y cambian en directo; la media solo cuenta partidos finalizados.
        </p>
      )}
    </section>
  );
}

function FieldSummary({ c, average }: { c: Counters; average: MyAverage | null }) {
  const s = c.shots;
  const pen = c.shotsByType.penalty;
  return (
    <>
      <div className="hero">
        <Ring pct={efficiency(s)} label="Eficacia" />
        <div className="hero-text">
          <span className="hero-label">Eficacia</span>
          {s.attempts > 0 ? (
            <>
              <strong>
                {s.goals} {s.goals === 1 ? 'gol' : 'goles'} de {s.attempts} {s.attempts === 1 ? 'lanzamiento' : 'lanzamientos'}
              </strong>
              <span className="muted">
                {s.out} fuera · {s.saved} {s.saved === 1 ? 'parado' : 'parados'} por el portero rival
              </span>
            </>
          ) : (
            <strong>Todavía sin lanzamientos registrados</strong>
          )}
        </div>
      </div>
      <div className="tiles myplayer-tiles">
        <Tile label="Goles" value={s.goals} sub={averageSub(average)} accent />
        <Tile label="Lanzamientos" value={s.attempts} />
        <Tile label="Recuperaciones" value={c.recoveries} />
        <Tile label="Goles de 7 m" value={pen.goals} sub={pen.attempts > 0 ? `de ${pen.attempts}` : undefined} />
      </div>
    </>
  );
}

function KeeperSummary({ c, average }: { c: Counters; average: MyAverage | null }) {
  const gk = c.gk;
  const pen = c.gkByType.penalty;
  return (
    <>
      <div className="hero">
        <Ring pct={savePct(gk)} label="Porcentaje de paradas" />
        <div className="hero-text">
          <span className="hero-label">% paradas</span>
          {onTarget(gk) > 0 ? (
            <>
              <strong>
                {gk.saves} {gk.saves === 1 ? 'parada' : 'paradas'} de {onTarget(gk)} entre palos
              </strong>
              <span className="muted">
                {gk.out} {gk.out === 1 ? 'lanzamiento fuera' : 'lanzamientos fuera'}
              </span>
            </>
          ) : (
            <strong>Todavía sin lanzamientos recibidos entre palos</strong>
          )}
        </div>
      </div>
      <div className="tiles myplayer-tiles">
        <Tile label="Paradas" value={gk.saves} sub={averageSub(average)} accent />
        <Tile label="Entre palos" value={onTarget(gk)} />
        <Tile label="Goles encajados" value={gk.goals} />
        <Tile label="Penaltis parados" value={pen.saves} sub={onTarget(pen) > 0 ? `de ${onTarget(pen)}` : undefined} />
      </div>
    </>
  );
}

const openMatch = (teamId: string, matchId: string) => openFromTeam(teamId, { name: 'remoteMatch', teamId, matchId });

/**
 * Evolución partido a partido: los últimos partidos finalizados con convocatoria
 * (la serie de myEvolution, sin el partido en juego). Cada uno abre su partido,
 * igual que «Últimos partidos».
 */
function Evolution({ teamId, evolution }: { teamId: string; evolution: MyEvolution }) {
  const { series, counts } = evolution;
  return (
    <section className="card myplayer-evolution" aria-labelledby="myplayer-evolution-title">
      <h3 id="myplayer-evolution-title">Evolución</h3>
      {series.length === 0 ? (
        <p className="hint">Aparecerá cuando termine su primer partido con convocatoria.</p>
      ) : (
        <>
          <p className="hint">
            {series.length === 1
              ? 'Su partido finalizado con convocatoria.'
              : series.length < counts.finished
                ? `Sus últimos ${series.length} partidos finalizados con convocatoria (de ${counts.finished}).`
                : 'Sus partidos finalizados con convocatoria.'}{' '}
            Solo refleja las acciones registradas.
          </p>
          <EvolutionBars points={series} title="Evolución partido a partido" onOpen={(matchId) => openMatch(teamId, matchId)} />
          {evolution.comparisons.map((c) => (
            <RecentForm key={c.position} comparison={c} mixed={evolution.mixedPositions} />
          ))}
        </>
      )}
    </section>
  );
}

/** Una cifra con un decimal: «2,0». */
const oneDecimal = (v: number) => v.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const shortDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/**
 * Últimos 3 partidos frente a la temporada, en una posición (solo con al menos
 * seis partidos finalizados en ella). Dos cifras y sus denominadores: sin
 * valoraciones, flechas ni colores.
 */
function RecentForm({ comparison: c, mixed }: { comparison: MyComparison; mixed: boolean }) {
  const { recent, season } = comparisonAverages(c);
  // Sin ningún partido válido en toda la temporada no hay nada que comparar.
  if (season.value === null) return null;
  const keeper = c.position === 'goalkeeper';
  const metric = keeper ? 'Paradas de media' : 'Goles de media';
  const as = keeper ? 'como portero' : 'como jugador de campo';
  const period = `del ${shortDate(c.recentDates.from)} al ${shortDate(c.recentDates.to)}`;
  const recentBase = keeper
    ? `${recent.denominator} de 3 con lanzamientos entre palos`
    : `sobre ${count(recent.denominator, 'convocatoria', 'convocatorias')}`;
  const seasonBase = keeper
    ? `sobre ${count(season.denominator, 'partido', 'partidos')} con lanzamientos entre palos`
    : `sobre ${count(season.denominator, 'convocatoria', 'convocatorias')}`;
  return (
    <section className="evo-compare" aria-label={`Últimos 3 y temporada${mixed ? ` ${as}` : ''}`}>
      <h4>
        {metric}
        {mixed && <span className="muted"> · {keeper ? 'Portero' : 'Jugador de campo'}</span>}
      </h4>
      <dl className="evo-compare-figures">
        <div>
          <dt>Últimos 3</dt>
          <dd>{recent.value === null ? <span className="muted">Sin media</span> : <strong>{oneDecimal(recent.value)}</strong>}</dd>
          <dd className="evo-compare-base">{recentBase}</dd>
        </div>
        <div>
          <dt>Temporada</dt>
          <dd>
            <strong>{oneDecimal(season.value)}</strong>
          </dd>
          <dd className="evo-compare-base">{seasonBase}</dd>
        </div>
      </dl>
      <p className="hint">
        {keeper
          ? `Últimos 3: partidos finalizados ${as} ${period}. Medias por partido con lanzamientos entre palos registrados.`
          : `Últimos 3: partidos finalizados ${as} ${period}. Medias por convocatoria en partido finalizado.`}
      </p>
    </section>
  );
}

/** Partido en juego: marcador, estado y lo que lleva el jugador (o que no está convocado). */
function LiveCard({ teamId, m }: { teamId: string; m: MyMatch }) {
  const line = m.counters && m.position ? matchLine(m.counters, m.position) : null;
  return (
    <button type="button" className="card myplayer-live-card" onClick={() => openMatch(teamId, m.match.id)}>
      <span className="myplayer-live-top">
        <span className="status status-in_progress">
          <Icon as={Radio} size={14} /> En directo · {MATCH_STATUS_LABEL[m.match.status]}
        </span>
        <span className="score-sm">
          {m.score.own} – {m.score.opponent}
        </span>
      </span>
      <strong>{opponentLabel(m.match.opponent)}</strong>
      <span className="muted">
        {m.counters === null ? 'No está convocado en este partido.' : (line ?? 'Convocado; todavía sin acciones registradas.')}
      </span>
      <span className="myplayer-more">
        Ver el partido <Icon as={ChevronRight} size={16} />
      </span>
    </button>
  );
}

const ordinal = (n: number) => `${n}.º`;

/** Su puesto en las clasificaciones positivas, también fuera del Top 10 (solo el suyo). */
function RankingsCard({ teamId, rankings }: { teamId: string; rankings: readonly MyRanking[] }) {
  return (
    <section className="card myplayer-ranks" aria-labelledby="myplayer-ranks-title">
      <h3 id="myplayer-ranks-title">Sus rankings</h3>
      <ul>
        {rankings.map(({ def, entry, ranked, inTop }) => (
          <li key={def.id}>
            <Icon as={RANKING_ICON[def.id]} size={20} className="myplayer-rank-icon" />
            <span className="list-main">
              <strong>{def.title}</strong>
              <span className="muted">
                {entry
                  ? def.format === 'pct'
                    ? `${formatPct(entry.value)} · ${entry.made}/${entry.of}`
                    : `${entry.value} ${entry.value === 1 ? def.unit![0] : def.unit![1]}`
                  : `Aún sin clasificar.${def.minimum ? ` ${def.minimum}` : ''}`}
              </span>
            </span>
            {entry && (
              <span className={`myplayer-rank-pos${inTop ? ' top' : ''}`}>
                <strong>{ordinal(entry.position)}</strong>
                <small>de {ranked}</small>
              </span>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-block" onClick={() => openFromTeam(teamId, { name: 'remoteRankings', teamId })}>
        <Icon as={Trophy} />
        Ver los rankings del equipo
      </button>
    </section>
  );
}

/** Últimos partidos finalizados en los que figura convocado, con sus cifras de cada uno. */
function RecentMatches({ teamId, matches }: { teamId: string; matches: readonly MyMatch[] }) {
  return (
    <section aria-labelledby="myplayer-recent-title">
      <h3 id="myplayer-recent-title" className="section-title">
        Últimos partidos
      </h3>
      <ul className="list">
        {matches.map((m) => {
          const badge = statusBadge(m.match.status, m.score);
          const line = m.counters && m.position ? matchLine(m.counters, m.position) : null;
          return (
            <li key={m.match.id}>
              <button type="button" className="list-item" onClick={() => openMatch(teamId, m.match.id)}>
                <span className="list-main">
                  <strong>{opponentLabel(m.match.opponent)}</strong>
                  <span className="muted">{formatDate(m.match.date)}</span>
                  <span className="myplayer-line">{line ?? 'Sin acciones registradas'}</span>
                </span>
                <span className="list-side">
                  <span className="score-sm">
                    {m.score.own} – {m.score.opponent}
                  </span>
                  <span className={`status status-${badge.tone}`}>{badge.label}</span>
                </span>
                <Icon as={ChevronRight} className="chevron" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
