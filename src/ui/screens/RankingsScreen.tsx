// Rankings del equipo: clasificaciones de la temporada calculadas con el motor
// estadístico (ver src/stats/rankings.ts). Solo lectura.
import {
  BrickWall,
  Crosshair,
  Crown,
  Gift,
  HandGrab,
  Shield,
  Target,
  Timer,
  Trophy,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { repo } from '../../app/repo';
import { navigate } from '../../app/router';
import { useLoad } from '../../app/useLoad';
import { formatPct } from '../../domain/format';
import type { Id } from '../../domain/types';
import { loadSeasonItems } from '../../services/statsService';
import { computeSeasonStats } from '../../stats/engine';
import {
  rankPlayers,
  RANKING_LIMIT,
  RANKINGS,
  rankingById,
  seasonCandidates,
  topOf,
  type RankedEntry,
  type RankingDefinition,
  type RankingId,
} from '../../stats/rankings';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';

const RANKING_ICON: Record<RankingId, LucideIcon> = {
  top_scorer: Target,
  sharpshooter: Crosshair,
  wall: Shield,
  saves: BrickWall,
  thief: HandGrab,
  repeat_offender: Timer,
  generous: Gift,
  shots: Zap,
};

function formatValue(def: RankingDefinition, e: RankedEntry): string {
  return def.format === 'pct' ? formatPct(e.value) : String(e.value);
}

/** «8 goles», «62,5 % · 8/13». */
function valueDetail(def: RankingDefinition, e: RankedEntry): string {
  if (def.format === 'pct') return `${e.made}/${e.of}`;
  const [one, many] = def.unit!;
  return e.value === 1 ? one : many;
}

export function RankingsScreen({ teamId }: { teamId: Id }) {
  const data = useLoad(async () => {
    const [team, items] = await Promise.all([repo.getTeam(teamId), loadSeasonItems(repo, teamId)]);
    return { team, items };
  }, [teamId]);
  const team = data.data?.team;
  const items = data.data?.items;

  const [season, setSeason] = useState<string | null>(null);
  const activeSeason = season ?? team?.season ?? '';
  const seasons = useMemo(() => {
    const set = new Set((items ?? []).map((i) => i.match.season));
    if (team) set.add(team.season);
    return [...set].sort().reverse();
  }, [items, team]);

  const [rankingId, setRankingId] = useState<RankingId>('top_scorer');
  const def = rankingById(rankingId);

  const stats = useMemo(
    () => computeSeasonStats((items ?? []).filter((i) => i.match.season === activeSeason)),
    [items, activeSeason],
  );
  const ranked = useMemo(() => rankPlayers(def, seasonCandidates(stats)), [def, stats]);

  const back = () => navigate({ name: 'team', teamId });

  if (data.error) return <p className="form-error">{data.error}</p>;
  if (data.data && !team) return null;

  return (
    <div className="screen">
      <TopBar
        title={
          <span className="title-with-icon">
            <Icon as={Trophy} />
            Rankings
          </span>
        }
        subtitle={team ? `${team.name} · Temporada ${activeSeason}` : undefined}
        back={back}
      />
      {data.data && (
        <main className="content">
          {seasons.length > 1 && (
            <div className="filters">
              <label>
                Temporada
                <select value={activeSeason} onChange={(e) => setSeason(e.target.value)}>
                  {seasons.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <RankingPicker value={rankingId} onChange={setRankingId} />

          <section className="rank-intro">
            <h2>
              <Icon as={RANKING_ICON[def.id]} size={18} />
              {def.title}
            </h2>
            <p>{def.description}</p>
            {def.minimum && <p className="rank-min">{def.minimum}</p>}
          </section>

          {stats.matches === 0 ? (
            <RankEmpty title="Todavía no hay partidos" text={`No hay partidos jugados en la temporada ${activeSeason}.`} />
          ) : ranked.length === 0 ? (
            <RankEmpty
              title="Sin clasificación todavía"
              text={def.minimum ? `Ningún jugador alcanza el mínimo. ${def.minimum}` : 'Nadie suma todavía en esta estadística.'}
            />
          ) : (
            <RankingTable def={def} ranked={ranked} matches={stats.matches} season={activeSeason} />
          )}
        </main>
      )}
    </div>
  );
}

function RankingPicker({ value, onChange }: { value: RankingId; onChange: (id: RankingId) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Mantiene visible la opción elegida en el carrusel.
  useLayoutEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  return (
    <div className="rank-picker" role="tablist" aria-label="Clasificación" ref={ref}>
      {RANKINGS.map((r) => (
        <button
          key={r.id}
          type="button"
          role="tab"
          aria-selected={r.id === value}
          className={r.id === value ? 'on' : ''}
          onClick={() => onChange(r.id)}
        >
          <Icon as={RANKING_ICON[r.id]} size={16} />
          {r.short}
        </button>
      ))}
    </div>
  );
}

function RankEmpty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-card">
      <Icon as={Trophy} size={28} className="rank-empty-icon" />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function RankingTable({
  def,
  ranked,
  matches,
  season,
}: {
  def: RankingDefinition;
  ranked: RankedEntry[];
  matches: number;
  season: string;
}) {
  const { entries, hiddenTies } = topOf(ranked);
  const leaders = entries.filter((e) => e.position === 1);
  const lead = leaders[0]!;

  return (
    <>
      <section className="rank-leader" aria-label="Líder">
        <Icon as={Crown} size={28} className="rank-crown" />
        <div className="rank-leader-who">
          <span className="rank-leader-label">{leaders.length > 1 ? 'Líderes empatados' : 'Líder'}</span>
          {leaders.length === 1 ? (
            <strong>
              <span className="dorsal">{lead.player.number}</span> {lead.player.name}
            </strong>
          ) : leaders.length <= 3 ? (
            <strong>{leaders.map((e) => e.player.name).join(' · ')}</strong>
          ) : (
            <strong>{leaders.length} jugadores</strong>
          )}
        </div>
        <div className="rank-leader-value">
          <strong>{formatValue(def, lead)}</strong>
          <span>{valueDetail(def, lead)}</span>
        </div>
      </section>

      <ol className="rank-list">
        {entries.map((e) => (
          <li key={e.player.playerId} className={e.position === 1 ? 'first' : undefined}>
            <span className="rank-pos">{e.position}</span>
            <span className="dorsal">{e.player.number}</span>
            <span className="rank-name">
              <span>{e.player.name}</span>
              <small>{e.player.matches} PJ</small>
            </span>
            <span className="rank-value">
              <strong>{formatValue(def, e)}</strong>
              {def.format === 'pct' && <small>{valueDetail(def, e)}</small>}
            </span>
          </li>
        ))}
      </ol>
      {hiddenTies > 0 && (
        <p className="hint">
          {hiddenTies === 1
            ? `Otro jugador empata en el puesto ${entries.at(-1)!.position}, pero no cabe`
            : `Otros ${hiddenTies} jugadores empatan en el puesto ${entries.at(-1)!.position}, pero no caben`}{' '}
          en el Top {RANKING_LIMIT}.
        </p>
      )}
      <p className="hint">
        Temporada {season}: {matches} {matches === 1 ? 'partido' : 'partidos'}. Solo cuentan las acciones atribuidas a
        un jugador; los partidos eliminados no cuentan.
      </p>
    </>
  );
}
