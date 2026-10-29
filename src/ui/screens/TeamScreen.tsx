import { ChevronRight, Pencil, Plus, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { repo } from '../../app/repo';
import { navigate } from '../../app/router';
import { showToast } from '../../app/toast';
import { useLoad } from '../../app/useLoad';
import { formatDate, opponentLabel } from '../../domain/format';
import type { Id, Player, Team } from '../../domain/types';
import { loadSeasonItems } from '../../services/statsService';
import { computeMatchStats, computeSeasonStats, perMatch } from '../../stats/engine';
import { Icon } from '../components/Icon';
import { statusBadge } from '../match/labels';
import { Segmented } from '../components/Segmented';
import { TopBar } from '../components/TopBar';
import { StatsView } from '../stats/StatsView';
import { Tile } from '../stats/StatTables';
import { ClubLinkCard } from './ClubLinkCard';
import { OngoingMatchBanner } from './OngoingMatchBanner';
import { PlayerFormSheet } from './PlayerFormSheet';
import { TeamFormSheet } from './TeamFormSheet';

type Tab = 'matches' | 'roster' | 'season';

export function TeamScreen({ teamId }: { teamId: Id }) {
  const team = useLoad(() => repo.getTeam(teamId), [teamId]);
  const [tab, setTab] = useState<Tab>('matches');
  const [editingTeam, setEditingTeam] = useState(false);

  if (team.error) return <p className="form-error">{team.error}</p>;
  if (!team.data) return team.data === undefined ? <div className="screen" /> : null;
  const t = team.data;

  return (
    <div className="screen">
      <TopBar
        title={t.name}
        subtitle={`${t.code} · Temporada ${t.season}`}
        back={() => navigate({ name: 'teams' })}
        actions={
          <>
            <button
              type="button"
              className="icon-btn"
              onClick={() => navigate({ name: 'rankings', teamId: t.id })}
              aria-label="Rankings"
            >
              <Icon as={Trophy} />
            </button>
            <button type="button" className="icon-btn" onClick={() => setEditingTeam(true)} aria-label="Editar equipo">
              <Icon as={Pencil} />
            </button>
          </>
        }
      />
      <main className="content">
        <OngoingMatchBanner teamId={t.id} />
        <ClubLinkCard team={t} />
        <Segmented
          ariaLabel="Secciones del equipo"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'matches', label: 'Partidos' },
            { value: 'roster', label: 'Plantilla' },
            { value: 'season', label: 'Temporada' },
          ]}
        />
        {tab === 'matches' && <MatchList team={t} />}
        {tab === 'roster' && <Roster team={t} />}
        {tab === 'season' && <SeasonPanel team={t} />}
      </main>
      {editingTeam && (
        <TeamFormSheet
          team={t}
          onClose={() => setEditingTeam(false)}
          onSaved={() => {
            setEditingTeam(false);
            team.reload();
            showToast('Equipo guardado');
          }}
        />
      )}
    </div>
  );
}

function MatchList({ team }: { team: Team }) {
  const data = useLoad(async () => {
    const matches = await repo.listMatches(team.id);
    return Promise.all(
      matches.map(async (m) => {
        const score = computeMatchStats(m, await repo.listEvents(m.id)).score;
        return { match: m, score, badge: statusBadge(m.status, score) };
      }),
    );
  }, [team.id]);

  return (
    <>
      <button
        type="button"
        className="btn btn-primary btn-block btn-lg"
        onClick={() => navigate({ name: 'newMatch', teamId: team.id })}
      >
        <Icon as={Plus} />
        Nuevo partido
      </button>
      {data.error && <p className="form-error">{data.error}</p>}
      {data.data?.length === 0 && (
        <div className="empty-card">
          <strong>Todavía no hay partidos</strong>
          <span>Crea el primero para empezar a registrar estadísticas.</span>
        </div>
      )}
      <ul className="list">
        {data.data?.map(({ match, score, badge }) => (
          <li key={match.id}>
            <button
              type="button"
              className="list-item"
              onClick={() => navigate({ name: 'match', matchId: match.id })}
            >
              <span className="list-main">
                <strong>{opponentLabel(match.opponent)}</strong>
                <span className="muted">
                  {formatDate(match.date)} · {match.venue === 'home' ? 'Local' : 'Visitante'} · {match.season}
                </span>
              </span>
              <span className="list-side">
                <span className="score-sm">
                  {score.own} – {score.opponent}
                </span>
                <span className={`status status-${badge.tone}`}>{badge.label}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Roster({ team }: { team: Team }) {
  const players = useLoad(() => repo.listPlayers(team.id), [team.id]);
  const [editing, setEditing] = useState<{ player?: Player; key: number } | null>(null);
  const list = players.data ?? [];
  const groups: [string, Player[]][] = [
    ['Jugadores de campo', list.filter((p) => p.position === 'field')],
    ['Porteros', list.filter((p) => p.position === 'goalkeeper')],
  ];

  return (
    <>
      <button type="button" className="btn btn-primary btn-block" onClick={() => setEditing({ key: Date.now() })}>
        <Icon as={Plus} />
        Añadir jugador
      </button>
      {players.error && <p className="form-error">{players.error}</p>}
      {groups.map(([title, group]) => (
        <section key={title}>
          <h3 className="section-title">
            {title} <span className="muted">({group.filter((p) => p.active).length})</span>
          </h3>
          {group.length === 0 && <p className="empty">Ninguno.</p>}
          <ul className="list">
            {group.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`list-item ${p.active ? '' : 'inactive'}`}
                  onClick={() => setEditing({ player: p, key: Date.now() })}
                >
                  <span className="dorsal dorsal-lg">{p.number}</span>
                  <span className="list-main">
                    <strong>{p.name}</strong>
                    {!p.active && <span className="muted">Inactivo</span>}
                  </span>
                  <Icon as={ChevronRight} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {editing && (
        <PlayerFormSheet
          key={editing.key}
          teamId={team.id}
          player={editing.player}
          onClose={() => setEditing(null)}
          onSaved={(p, addAnother) => {
            players.reload();
            showToast(`${p.number} · ${p.name} guardado`);
            setEditing(addAnother ? { key: Date.now() } : null);
          }}
        />
      )}
    </>
  );
}

function SeasonPanel({ team }: { team: Team }) {
  const data = useLoad(() => loadSeasonItems(repo, team.id), [team.id]);

  const seasons = useMemo(() => {
    const set = new Set((data.data ?? []).map((i) => i.match.season));
    set.add(team.season);
    return [...set].sort().reverse();
  }, [data.data, team.season]);
  const [season, setSeason] = useState(team.season);
  const [onlyFinished, setOnlyFinished] = useState(false);

  const items = useMemo(
    () =>
      (data.data ?? []).filter((i) => i.match.season === season && (!onlyFinished || i.match.status === 'finished')),
    [data.data, season, onlyFinished],
  );
  const stats = useMemo(() => computeSeasonStats(items), [items]);
  const rows = [...stats.players.values()]
    .map((p) => ({ ...p.latest, matches: p.matches, counters: p.counters }))
    .sort((a, b) => a.number - b.number);
  const avg = (v: number | null) => (v === null ? '—' : v.toLocaleString('es-ES', { maximumFractionDigits: 1 }));

  if (data.error) return <p className="form-error">{data.error}</p>;
  return (
    <>
      <div className="filters">
        <label>
          Temporada
          <select value={season} onChange={(e) => setSeason(e.target.value)}>
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyFinished} onChange={(e) => setOnlyFinished(e.target.checked)} />
          Solo finalizados
        </label>
      </div>
      <button type="button" className="list-item rank-link" onClick={() => navigate({ name: 'rankings', teamId: team.id })}>
        <span className="rank-link-icon">
          <Icon as={Trophy} />
        </span>
        <span className="list-main">
          <strong>Rankings</strong>
          <span className="muted">Pistolero, francotirador, el muro…</span>
        </span>
        <Icon as={ChevronRight} className="chevron" />
      </button>
      {stats.matches === 0 ? (
        <p className="empty">No hay partidos registrados en esta temporada.</p>
      ) : (
        <StatsView
          mode="season"
          context={`Temporada ${season}`}
          team={stats.team}
          rows={rows}
          intervals={stats.intervals}
          pendingCount={stats.pendingCount}
          summary={
            <>
              <div className="tiles tiles-3">
                <Tile label="Partidos" value={stats.matches} />
                <Tile
                  label="A favor"
                  value={stats.goalsFor}
                  sub={`${avg(perMatch(stats.goalsFor, stats.matches))}/p`}
                />
                <Tile
                  label="En contra"
                  value={stats.goalsAgainst}
                  sub={`${avg(perMatch(stats.goalsAgainst, stats.matches))}/p`}
                />
              </div>
              <p className="hint">
                Goles a favor y en contra incluyen las correcciones manuales del marcador; el resto de cifras, solo las
                acciones registradas.
              </p>
            </>
          }
        />
      )}
    </>
  );
}
