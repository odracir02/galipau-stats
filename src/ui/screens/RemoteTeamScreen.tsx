// Equipo del club al que este dispositivo tiene acceso por código: consulta de
// sus partidos, jugadores, estadísticas y rankings, descargados del servidor.
// SOLO LECTURA para cualquier rol (también entrenador): aquí no se registra,
// corrige, finaliza ni elimina nada. Los datos descargados son independientes
// de los equipos guardados en el dispositivo.
import { ChevronRight, CloudOff, Radio, RefreshCw, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../app/errors';
import { clubViewer, liveFeed, remote } from '../../app/remote';
import { navigate } from '../../app/router';
import { showToast } from '../../app/toast';
import { useRemoteTeamData } from '../../app/useRemoteTeamData';
import { formatDate, opponentLabel } from '../../domain/format';
import { formatChecked, ROLE_LABEL } from '../../remote/session';
import { seasonItems, type TeamView } from '../../remote/viewer';
import { computeMatchStats } from '../../stats/engine';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { ConfirmSheet } from '../components/Sheet';
import { TopBar } from '../components/TopBar';
import { statusBadge } from '../match/labels';
import { SeasonView } from '../stats/SeasonView';
import { KV } from '../stats/StatTables';

type Tab = 'matches' | 'players' | 'season';

/** Hora de los datos: con segundos si son de hoy (actualización en directo). */
function dataTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : formatChecked(iso);
}

/**
 * Estado de los datos descargados: «En directo» solo si la última consulta ha
 * confirmado con el servidor que están al día; si no, la hora de los últimos
 * datos recibidos. Con «Actualizar» y avisos sin conexión.
 */
export function FreshnessBar({
  view,
  onRefresh,
  onResume,
}: {
  view: TeamView;
  onRefresh: (() => void) | null;
  /** «Reanudar directo» tras la pausa por tiempo. */
  onResume?: (() => void) | null;
}) {
  const iso = view.checkedAt ?? view.cached?.fetchedAt ?? null;
  const at = iso ? dataTime(iso) : null;
  const live = view.live ?? null;
  let text: string;
  if (view.loading) text = 'Actualizando…';
  else if (!at) text = live === 'checking' || live === 'retrying' ? 'Descargando…' : 'Sin datos descargados';
  else if (live === 'live') text = `En directo · actualizado a las ${at}`;
  else if (live === 'checking' || live === 'retrying') text = `Actualizando… · datos de las ${at}`;
  else if (live === 'offline') text = `Sin conexión · datos de las ${at}`;
  else if (live === 'stale') text = `Datos desactualizados · última actualización a las ${at}`;
  else if (live === 'paused') text = `Actualización automática pausada · datos de las ${at}`;
  else text = `Datos del club · actualizados ${at}`;
  const warn = view.problem === 'offline' || (view.problem === 'server' && live !== 'retrying' && live !== 'checking');
  return (
    <div className="fresh-bar" role="status">
      <span className={`fresh-text${live ? ` live-${live}` : ''}`}>
        {live && <span className="live-dot" aria-hidden="true" />}
        {text}
      </span>
      {live === 'paused' && onResume && (
        <button type="button" className="btn btn-sm" onClick={onResume}>
          <Icon as={Radio} size={16} />
          Reanudar directo
        </button>
      )}
      {onRefresh && (
        <button type="button" className="btn btn-sm" onClick={onRefresh} disabled={view.loading}>
          <Icon as={RefreshCw} size={16} />
          Actualizar
        </button>
      )}
      {warn && (
        <p className="notice fresh-warning">
          <Icon as={CloudOff} size={18} />
          {view.problem === 'offline' ? 'Sin conexión.' : 'El servidor no responde.'}{' '}
          {at ? `Se muestran los datos de las ${at}: pueden estar desactualizados.` : 'Todavía no hay datos descargados de este equipo.'}
        </p>
      )}
    </div>
  );
}

export function RemoteTeamScreen({ teamId }: { teamId: string }) {
  const { session, view, team } = useRemoteTeamData(teamId);
  const [tab, setTab] = useState<Tab>('matches');
  const [leaving, setLeaving] = useState(false);
  const back = () => navigate({ name: 'teams' });
  const snapshot = view.cached?.snapshot;
  const items = useMemo(() => (snapshot ? seasonItems(snapshot) : []), [snapshot]);

  if (!remote || (session.ready && !team)) {
    return (
      <div className="screen">
        <TopBar title="Equipo del club" back={back} />
        <main className="content">
          <p className="empty">Este dispositivo no tiene acceso a ese equipo.</p>
        </main>
      </div>
    );
  }
  if (!team) return <div className="screen" />;
  const refresh = clubViewer && liveFeed && team.status === 'active' ? () => void liveFeed!.refreshNow(team.teamId) : null;

  return (
    <div className="screen">
      <TopBar
        title={team.name}
        subtitle={`${team.clubName} · Temporada ${team.season}`}
        back={back}
        actions={
          snapshot ? (
            <button type="button" className="icon-btn" onClick={() => navigate({ name: 'remoteRankings', teamId })} aria-label="Rankings">
              <Icon as={Trophy} />
            </button>
          ) : undefined
        }
      />
      <main className="content">
        {team.status !== 'active' && (
          <p className="notice">El club no está activo ahora mismo. Los datos del equipo no están disponibles.</p>
        )}
        {view.problem === 'no_access' && <p className="notice">Este dispositivo ya no tiene acceso a este equipo.</p>}
        <FreshnessBar view={view} onRefresh={refresh} onResume={() => liveFeed?.resume(teamId)} />
        <p className="hint readonly-note">
          Solo consulta ({ROLE_LABEL[team.role]}): aquí no se registra ni se modifica nada. Los datos del club son independientes
          de los equipos de este dispositivo.
        </p>
        {snapshot && (
          <>
            <Segmented
              ariaLabel="Secciones del equipo del club"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'matches', label: 'Partidos' },
                { value: 'players', label: 'Jugadores' },
                { value: 'season', label: 'Temporada' },
              ]}
            />
            {tab === 'matches' && <RemoteMatchList teamId={teamId} snapshot={snapshot} />}
            {tab === 'players' && <RemotePlayers snapshot={snapshot} />}
            {tab === 'season' && (
              <SeasonView items={items} defaultSeason={team.season} onRankings={() => navigate({ name: 'remoteRankings', teamId })} />
            )}
          </>
        )}
        <section className="card">
          <h3>Equipo del club</h3>
          <dl className="kv">
            <KV k="Club" v={team.clubName} />
            <KV k="Código del equipo" v={team.code} />
            <KV k="Tu permiso" v={<span className={`status status-${team.role}`}>{ROLE_LABEL[team.role]}</span>} />
          </dl>
        </section>
        <button type="button" className="btn btn-danger-outline btn-block" onClick={() => setLeaving(true)}>
          Salir de este equipo
        </button>
      </main>
      {leaving && (
        <ConfirmSheet
          title="Salir del equipo"
          message={
            <>
              <p>
                Este dispositivo dejará de tener acceso a <strong>{team.name}</strong> ({team.clubName}) y se borrarán sus
                datos descargados. Para volver necesitarás un código.
              </p>
              <p>Los equipos y partidos guardados en este dispositivo no cambian.</p>
            </>
          }
          confirmLabel="Salir del equipo"
          danger
          onCancel={() => setLeaving(false)}
          onConfirm={async () => {
            try {
              await remote?.leave(team.teamId);
              await clubViewer?.forget(team.teamId);
              showToast('Has salido del equipo', 'info');
              navigate({ name: 'teams' }, { replace: true });
            } catch (e) {
              setLeaving(false);
              showToast(errorMessage(e), 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function RemoteMatchList({ teamId, snapshot }: { teamId: string; snapshot: NonNullable<TeamView['cached']>['snapshot'] }) {
  const rows = useMemo(() => {
    const events = new Map<string, (typeof snapshot.events)[number]['event'][]>();
    for (const { event } of snapshot.events) events.set(event.matchId, [...(events.get(event.matchId) ?? []), event]);
    return snapshot.matches
      .filter(({ match }) => match.deletedAt === null)
      .map(({ match }) => {
        const score = computeMatchStats(match, events.get(match.id) ?? []).score;
        return { match, score, badge: statusBadge(match.status, score) };
      })
      .sort((a, b) => b.match.date.localeCompare(a.match.date) || b.match.createdAt.localeCompare(a.match.createdAt));
  }, [snapshot]);
  if (rows.length === 0) return <p className="empty">Todavía no hay partidos en el servidor.</p>;
  return (
    <ul className="list">
      {rows.map(({ match, score, badge }) => (
        <li key={match.id}>
          <button type="button" className="list-item" onClick={() => navigate({ name: 'remoteMatch', teamId, matchId: match.id })}>
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
            <Icon as={ChevronRight} className="chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function RemotePlayers({ snapshot }: { snapshot: NonNullable<TeamView['cached']>['snapshot'] }) {
  const players = [...snapshot.players.map((p) => p.player)].sort((a, b) => a.number - b.number);
  const groups: [string, typeof players][] = [
    ['Jugadores de campo', players.filter((p) => p.position === 'field')],
    ['Porteros', players.filter((p) => p.position === 'goalkeeper')],
  ];
  return (
    <>
      {groups.map(([title, group]) => (
        <section key={title}>
          <h3 className="section-title">
            {title} <span className="muted">({group.filter((p) => p.active).length})</span>
          </h3>
          {group.length === 0 && <p className="empty">Ninguno.</p>}
          <ul className="list">
            {group.map((p) => (
              <li key={p.id}>
                <div className={`list-item ${p.active ? '' : 'inactive'}`}>
                  <span className="dorsal dorsal-lg">{p.number}</span>
                  <span className="list-main">
                    <strong>{p.name}</strong>
                    {!p.active && <span className="muted">Inactivo</span>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="hint">Las estadísticas de cada jugador están en «Temporada» y en cada partido.</p>
    </>
  );
}
