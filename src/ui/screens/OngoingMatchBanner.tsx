import { ChevronRight } from 'lucide-react';
import { repo } from '../../app/repo';
import { navigate } from '../../app/router';
import { useLoad } from '../../app/useLoad';
import { formatDate } from '../../domain/format';
import type { Id, Match } from '../../domain/types';
import { Icon } from '../components/Icon';

/** Recuperación de partidos interrumpidos: acceso directo a los que siguen abiertos. */
export function OngoingMatchBanner({ teamId }: { teamId?: Id }) {
  const ongoing = useLoad(async () => {
    const teams = teamId ? [{ id: teamId }] : await repo.listTeams();
    const lists = await Promise.all(teams.map((t) => repo.listMatches(t.id)));
    return lists.flat().filter((m: Match) => m.status === 'in_progress' || m.status === 'halftime');
  }, [teamId]);

  if (!ongoing.data?.length) return null;
  return (
    <div className="banner-stack">
      {ongoing.data.map((m) => (
        <button key={m.id} type="button" className="banner" onClick={() => navigate({ name: 'match', matchId: m.id })}>
          <span className="banner-dot" />
          <span className="banner-text">
            <strong>Partido en curso · vs {m.opponent}</strong>
            <span>{formatDate(m.date)} · toca para continuar</span>
          </span>
          <span className="banner-cta">
            Continuar
            <Icon as={ChevronRight} size={18} />
          </span>
        </button>
      ))}
    </div>
  );
}
