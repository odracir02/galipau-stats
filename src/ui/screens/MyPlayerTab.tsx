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
import { efficiency, onTarget, perMatch, savePct, type Counters } from '../../stats/engine';
import { Icon } from '../components/Icon';
import { Ring } from '../stats/charts';
import { statusBadge } from '../match/labels';
import { liveMatches, matchLine, myRankings, mySeason, recentMatches, type MyMatch, type MyRanking, type MySeason } from '../stats/mySeason';
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
  if (!chosen || !stats) {
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
      <SeasonSummary stats={stats} season={season} />
      {rankings.length > 0 && <RankingsCard teamId={teamId} rankings={rankings} />}
      {recent.length > 0 && <RecentMatches teamId={teamId} matches={recent} />}
      {card && <PlayerCard row={stats.row} mode="season" context={`Temporada ${season}`} onClose={() => setCard(false)} />}
    </>
  );
}

const avg = (v: number | null) => (v === null ? '—' : v.toLocaleString('es-ES', { maximumFractionDigits: 1 }));
/** «3/5», o «—» si no hay ninguno (nunca un 0 % engañoso). */
const ofTotal = (made: number, total: number) => (total > 0 ? `${made}/${total}` : '—');

/** Resumen de la temporada: las cifras principales, de un vistazo. El detalle, en la ficha completa. */
function SeasonSummary({ stats, season }: { stats: MySeason; season: string }) {
  const { row, matches, finished, live } = stats;
  const c = row.counters;
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
      {row.position === 'goalkeeper' ? <KeeperSummary c={c} matches={matches} /> : <FieldSummary c={c} matches={matches} />}
      <p className="hint">
        {matches} {matches === 1 ? 'partido' : 'partidos'} con convocatoria
        {finished !== matches && ` (${finished} ${finished === 1 ? 'finalizado' : 'finalizados'})`}.
        {live > 0 && (
          <span className="myplayer-live">
            {' '}
            <Icon as={Radio} size={14} /> Incluye el partido en juego: las cifras cambian en directo.
          </span>
        )}
      </p>
    </section>
  );
}

function FieldSummary({ c, matches }: { c: Counters; matches: number }) {
  const s = c.shots;
  const pen = c.shotsByType.penalty;
  const fast = c.shotsByType.fast_break;
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
        <Tile label="Partidos" value={matches} />
        <Tile label="Goles" value={s.goals} sub={`${avg(perMatch(s.goals, matches))}/p`} accent />
        <Tile label="Lanzamientos" value={s.attempts} />
        <Tile label="Penaltis (7 m)" value={ofTotal(pen.goals, pen.attempts)} />
        <Tile label="Contraataque" value={ofTotal(fast.goals, fast.attempts)} />
        <Tile label="Recuperaciones" value={c.recoveries} />
      </div>
    </>
  );
}

function KeeperSummary({ c, matches }: { c: Counters; matches: number }) {
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
        <Tile label="Partidos" value={matches} />
        <Tile label="Paradas" value={gk.saves} sub={`${avg(perMatch(gk.saves, matches))}/p`} accent />
        <Tile label="Recibidos" value={gk.received} />
        <Tile label="Goles encajados" value={gk.goals} />
        <Tile label="Penaltis parados" value={ofTotal(pen.saves, onTarget(pen))} />
        <Tile label="Recuperaciones" value={c.recoveries} />
      </div>
    </>
  );
}

const openMatch = (teamId: string, matchId: string) => openFromTeam(teamId, { name: 'remoteMatch', teamId, matchId });

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
