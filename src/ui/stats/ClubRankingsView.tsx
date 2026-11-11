// Rankings del club dentro de «Temporada»: alterna entre los del equipo (los de
// siempre) y los del club. Los del club los calcula y autoriza el servidor; aquí
// solo se presentan, con conexión, y no se guardan en ningún sitio.
import { CloudOff, Crown, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useClubRankingGroups } from '../../app/useClubRankings';
import { clubRankings } from '../../app/remote';
import { formatPct } from '../../domain/format';
import type { ClubRankingEntry, ClubRankingGroup, ClubRankings } from '../../remote/api';
import { RemoteError } from '../../remote/api';
import { groupKey, groupLabel, initialGroup, isAccessLost } from '../../remote/clubRankings';
import { RANKING_LIMIT, rankingById, type RankingDefinition, type RankingId } from '../../stats/rankings';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { RankEmpty, RankingPicker } from '../screens/RankingsScreen';
import { RANKING_ICON } from './rankingIcons';

const CLUB_RANKINGS: readonly RankingId[] = ['top_scorer', 'sharpshooter', 'wall', 'thief', 'shots'];
const CLUB_DEFS = CLUB_RANKINGS.map(rankingById);

/** Jugador del propio equipo cuyo puesto se puede consultar. */
export interface ClubRankingPlayer {
  id: string;
  name: string;
  number: number;
}

type Scope = 'team' | 'club';

/**
 * «Temporada» con el selector «Mi equipo / Mi club». Solo aparece si el servidor
 * ofrece grupos del club a este dispositivo; si no, `team` tal cual.
 */
export function SeasonWithClubRankings({
  clubId,
  teamId,
  clubName,
  players,
  defaultPlayerId,
  team,
}: {
  clubId: string | null | undefined;
  /** Equipo del club que se está consultando (para abrir en su grupo). */
  teamId: string | null | undefined;
  clubName: string;
  players: readonly ClubRankingPlayer[];
  defaultPlayerId?: string;
  team: ReactNode;
}) {
  const { state, recheck } = useClubRankingGroups(clubId);
  const [scope, setScope] = useState<Scope>('team');
  const groups = state.status === 'ready' ? state.groups : null;

  return (
    <>
      {groups && clubId && (
        <Segmented
          ariaLabel="Rankings de mi equipo o de mi club"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'team', label: 'Mi equipo' },
            { value: 'club', label: 'Mi club' },
          ]}
        />
      )}
      {state.status === 'none' && state.lost && (
        <p className="notice" role="status">
          Los rankings del club ya no están disponibles en este dispositivo.
        </p>
      )}
      {groups && clubId && scope === 'club' ? (
        <ClubRankingsView
          clubId={clubId}
          teamId={teamId}
          clubName={clubName}
          groups={groups}
          players={players}
          defaultPlayerId={defaultPlayerId}
          onAccessLost={recheck}
        />
      ) : (
        team
      )}
    </>
  );
}

type Load =
  | { key: string; request: string; status: 'ready'; data: ClubRankings }
  | { key: string; request: string; status: 'error'; error: unknown };

function ClubRankingsView({
  clubId,
  teamId,
  clubName,
  groups,
  players,
  defaultPlayerId,
  onAccessLost,
}: {
  clubId: string;
  teamId: string | null | undefined;
  clubName: string;
  groups: readonly ClubRankingGroup[];
  players: readonly ClubRankingPlayer[];
  defaultPlayerId?: string;
  onAccessLost: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  // Al abrir, el grupo del equipo; si el elegido deja de ofrecerse, también.
  const group = groups.find((g) => groupKey(g) === chosen) ?? initialGroup(groups, teamId)!;
  const [playerId, setPlayerId] = useState(() => (players.some((p) => p.id === defaultPlayerId) ? defaultPlayerId! : ''));
  const player = players.find((p) => p.id === playerId);
  const [rankingId, setRankingId] = useState<RankingId>('top_scorer');
  const def = rankingById(rankingId);
  const [reload, setReload] = useState(0);
  const [load, setLoad] = useState<Load | null>(null);

  // Lo que se muestra pertenece siempre a esta petición: club, grupo y jugador.
  const key = `${clubId}|${groupKey(group)}|${playerId}`;
  const request = `${key}#${reload}`;
  useEffect(() => {
    if (!clubRankings) return;
    // Una respuesta que llega tarde (otro grupo elegido entretanto, sección cerrada) se descarta.
    let alive = true;
    clubRankings.rankings(clubId, group, playerId ? [playerId] : []).then(
      (data) => alive && setLoad({ key, request, status: 'ready', data }),
      (error: unknown) => {
        if (!alive) return;
        // Sin conexión o sin permiso, no se deja a la vista nada anterior.
        setLoad({ key, request, status: 'error', error });
        if (isAccessLost(error)) onAccessLost();
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `request` resume club, grupo, jugador y actualización
  }, [request]);

  const pending = load?.request !== request;
  // Al actualizar el mismo grupo se mantiene lo mostrado hasta la respuesta; de otro grupo, nunca.
  const current: { status: 'loading' } | Load =
    load && load.key === key && (!pending || load.status === 'ready') ? load : { status: 'loading' };
  const data = current.status === 'ready' ? current.data : null;

  return (
    <>
      <div className="filters club-rank-filters">
        {groups.length > 1 && (
          <label>
            Grupo
            <select value={groupKey(group)} onChange={(e) => setChosen(e.target.value)}>
              {groups.map((g) => (
                <option key={groupKey(g)} value={groupKey(g)}>
                  {groupLabel(g)}
                </option>
              ))}
            </select>
          </label>
        )}
        {players.length > 0 && (
          <label>
            Ver el puesto de
            <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
              <option value="">Nadie</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} · {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <section className="card club-rank-head" aria-label="Rankings del club">
        <div className="club-rank-title">
          <h3>{clubName}</h3>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReload((n) => n + 1)}
            disabled={pending}
            aria-label="Actualizar los rankings del club"
          >
            <Icon as={RefreshCw} size={16} />
            {pending && data ? 'Actualizando…' : 'Actualizar'}
          </button>
        </div>
        <p className="club-rank-group">{groupLabel(group)}</p>
        {data && (
          <p className="hint">
            {data.teams.length === 1 ? 'Equipo' : 'Equipos'}: {data.teams.map((t) => `${t.name} (${t.code})`).join(', ')}.{' '}
            Calculado: {formatComputed(data.computedAt)}.
          </p>
        )}
      </section>

      {current.status === 'loading' && (
        <p className="empty" role="status">
          Cargando los rankings del club…
        </p>
      )}
      {current.status === 'error' && <ClubRankingsError error={current.error} onRetry={() => setReload((n) => n + 1)} />}
      {data && (
        <>
          <RankingPicker value={rankingId} onChange={setRankingId} options={CLUB_DEFS} />
          <section className="rank-intro">
            <h2>
              <Icon as={RANKING_ICON[def.id]} size={18} />
              {def.title}
            </h2>
            <p>{def.description}</p>
            {def.minimum && <p className="rank-min">{def.minimum}</p>}
          </section>
          {player && <MinePosition def={def} data={data} player={player} />}
          <ClubRankingTable def={def} data={data} />
        </>
      )}
    </>
  );
}

function ClubRankingsError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const kind = error instanceof RemoteError ? error.kind : 'unknown';
  const text =
    kind === 'offline' || kind === 'timeout'
      ? 'Sin conexión. Los rankings del club solo se consultan con conexión y no se guardan en el dispositivo.'
      : kind === 'unauthorized'
        ? 'La sesión de este dispositivo ya no es válida. Vuelve a unirte con un código del club.'
        : kind === 'forbidden' || kind === 'not_found'
          ? 'Estos rankings ya no están disponibles para este dispositivo.'
          : 'No se han podido cargar los rankings del club. Inténtalo de nuevo.';
  const retry = kind !== 'unauthorized' && kind !== 'forbidden' && kind !== 'not_found';
  return (
    <p className="notice" role="alert">
      {(kind === 'offline' || kind === 'timeout') && <Icon as={CloudOff} size={18} />}
      <span>{text}</span>
      {retry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </p>
  );
}

const ordinal = (n: number) => `${n}.º`;

function formatValue(def: RankingDefinition, e: { value: number }): string {
  return def.format === 'pct' ? formatPct(e.value) : String(e.value);
}

/** «8 goles» o «8/13». */
function valueDetail(def: RankingDefinition, e: { value: number; made?: number; of?: number }): string {
  if (def.format === 'pct') return `${e.made}/${e.of}`;
  const [one, many] = def.unit!;
  return e.value === 1 ? one : many;
}

function formatComputed(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const teamsLine = (e: ClubRankingEntry) => `${e.teams.join(' · ')} · ${e.matches} PJ`;

/** Puesto del jugador elegido en esta clasificación (también fuera del Top 10), si el servidor lo da. */
function MinePosition({ def, data, player }: { def: RankingDefinition; data: ClubRankings; player: ClubRankingPlayer }) {
  const mine = data.mine.find((m) => m.playerId === player.id);
  if (!mine) return null;
  const entry = mine.rankings.find((r) => r.id === def.id);
  return (
    <section className="card myplayer-ranks club-rank-mine" aria-label="Su puesto en el club">
      <ul>
        <li>
          <Icon as={RANKING_ICON[def.id]} size={20} className="myplayer-rank-icon" />
          <span className="list-main">
            <strong>
              {player.number} · {player.name}
            </strong>
            <span className="muted">
              {mine.excluded
                ? 'No participa en los rankings del club.'
                : entry
                  ? def.format === 'pct'
                    ? `${formatPct(entry.value)} · ${entry.made}/${entry.of}`
                    : `${entry.value} ${valueDetail(def, entry)}`
                  : `Aún sin clasificar.${def.minimum ? ` ${def.minimum}` : ''}`}
            </span>
          </span>
          {entry && !mine.excluded && (
            <span className={`myplayer-rank-pos${entry.position <= RANKING_LIMIT ? ' top' : ''}`}>
              <strong>{ordinal(entry.position)}</strong>
              <small>de {entry.ranked}</small>
            </span>
          )}
        </li>
      </ul>
    </section>
  );
}

function ClubRankingTable({ def, data }: { def: RankingDefinition; data: ClubRankings }) {
  const ranking = data.rankings.find((r) => r.id === def.id);
  const noMatches = useMemo(() => data.rankings.every((r) => r.ranked === 0), [data]);
  if (!ranking || ranking.entries.length === 0) {
    return noMatches ? (
      <RankEmpty title="Todavía no hay partidos" text={`No hay partidos de los equipos del grupo en la temporada ${data.season}.`} />
    ) : (
      <RankEmpty
        title="Sin clasificación todavía"
        text={def.minimum ? `Nadie alcanza el mínimo. ${def.minimum}` : 'Nadie suma todavía en esta estadística.'}
      />
    );
  }
  const leaders = ranking.entries.filter((e) => e.position === 1);
  const rest = ranking.entries.filter((e) => e.position !== 1);
  const lead = leaders[0]!;
  const lastShown = ranking.entries.at(-1)!.position;

  return (
    <>
      <section className="rank-leader" aria-label="Líder">
        <Icon as={Crown} size={28} className="rank-crown" />
        <div className="rank-leader-who">
          <span className="rank-leader-label">{leaders.length > 1 ? 'Líderes empatados' : 'Líder'}</span>
          {leaders.length === 1 ? (
            <>
              <strong>{lead.name}</strong>
              <small className="club-rank-teams">{teamsLine(lead)}</small>
            </>
          ) : (
            <ul className="rank-leader-names">
              {leaders.map((e, i) => (
                <li key={i}>
                  {e.name} <small className="club-rank-teams">{teamsLine(e)}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rank-leader-value">
          <strong>{formatValue(def, lead)}</strong>
          <span>{valueDetail(def, lead)}</span>
        </div>
      </section>

      {rest.length > 0 && (
        <ol className="rank-list">
          {rest.map((e, i) => (
            <li key={i}>
              <span className="rank-pos">{e.position}</span>
              <span className="rank-name">
                <span>{e.name}</span>
                <small>{teamsLine(e)}</small>
              </span>
              <span className="rank-value">
                <strong>{formatValue(def, e)}</strong>
                <small>{valueDetail(def, e)}</small>
              </span>
            </li>
          ))}
        </ol>
      )}
      {ranking.hiddenTies > 0 && (
        <p className="hint">
          {ranking.hiddenTies === 1
            ? `Otro jugador empata en el puesto ${lastShown}, pero no cabe`
            : `Otros ${ranking.hiddenTies} jugadores empatan en el puesto ${lastShown}, pero no caben`}{' '}
          en el Top {RANKING_LIMIT}.
        </p>
      )}
      <p className="hint">
        {ranking.ranked} {ranking.ranked === 1 ? 'clasificado' : 'clasificados'} en el grupo. Una persona con fichas en varios
        equipos del grupo suma una sola vez.
      </p>
    </>
  );
}
