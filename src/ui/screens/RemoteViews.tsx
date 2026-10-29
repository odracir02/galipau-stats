// Partido y rankings de un equipo del club, con los datos descargados. Solo
// consulta: sin registro, cronología editable, corrección ni finalización.
import { Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { navigate } from '../../app/router';
import { useRemoteTeamData } from '../../app/useRemoteTeamData';
import { formatDate, opponentLabel } from '../../domain/format';
import { seasonItems } from '../../remote/viewer';
import { disqualifications } from '../../stats/discipline';
import { computeMatchStats } from '../../stats/engine';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { StatsView } from '../stats/StatsView';
import { MatchSummaryCard } from './MatchScreen';
import { RankingsView } from './RankingsScreen';
import { FreshnessBar } from './RemoteTeamScreen';

export function RemoteMatchScreen({ teamId, matchId }: { teamId: string; matchId: string }) {
  const { view, team } = useRemoteTeamData(teamId);
  const snapshot = view.cached?.snapshot;
  const match = snapshot?.matches.find((m) => m.match.id === matchId && m.match.deletedAt === null)?.match;
  const events = useMemo(() => snapshot?.events.map((e) => e.event).filter((e) => e.matchId === matchId) ?? [], [snapshot, matchId]);
  const stats = useMemo(() => (match ? computeMatchStats(match, events) : null), [match, events]);
  const back = () => navigate({ name: 'remoteTeam', teamId });

  if (!match || !stats || !snapshot) {
    return (
      <div className="screen">
        <TopBar title="Partido" back={back} />
        <main className="content">
          <p className="empty">{view.loading ? 'Cargando…' : 'Este partido no está entre los datos descargados.'}</p>
        </main>
      </div>
    );
  }
  return (
    <div className="screen">
      <TopBar title={opponentLabel(match.opponent)} subtitle={`${formatDate(match.date)} · ${team?.name ?? snapshot.team.name}`} back={back} />
      <main className="content">
        <FreshnessBar view={view} onRefresh={null} />
        <StatsView
          mode="match"
          context={`${opponentLabel(match.opponent)} · ${formatDate(match.date)}`}
          redCards={disqualifications(events)}
          team={stats.team}
          rows={match.squad.map((s) => ({ ...s, counters: stats.players.get(s.playerId)! }))}
          intervals={stats.intervals}
          pendingCount={stats.pendingCount}
          summary={<MatchSummaryCard match={match} teamName={snapshot.club.name} stats={stats} />}
        />
      </main>
    </div>
  );
}

export function RemoteRankingsScreen({ teamId }: { teamId: string }) {
  const { view, team } = useRemoteTeamData(teamId);
  const snapshot = view.cached?.snapshot;
  const items = useMemo(() => (snapshot ? seasonItems(snapshot) : []), [snapshot]);
  const defaultSeason = team?.season ?? snapshot?.team.season ?? '';
  const seasons = useMemo(() => [...new Set([...items.map((i) => i.match.season), defaultSeason])].sort().reverse(), [items, defaultSeason]);
  const [season, setSeason] = useState<string | null>(null);
  const active = season ?? defaultSeason;

  return (
    <div className="screen">
      <TopBar
        title={
          <span className="title-with-icon">
            <Icon as={Trophy} />
            Rankings
          </span>
        }
        subtitle={`${team?.name ?? snapshot?.team.name ?? ''} · Temporada ${active}`}
        back={() => navigate({ name: 'remoteTeam', teamId })}
      />
      <main className="content">
        <FreshnessBar view={view} onRefresh={null} />
        {snapshot ? (
          <RankingsView items={items} seasons={seasons} season={active} onSeason={setSeason} />
        ) : (
          <p className="empty">{view.loading ? 'Cargando…' : 'No hay datos descargados de este equipo.'}</p>
        )}
      </main>
    </div>
  );
}
