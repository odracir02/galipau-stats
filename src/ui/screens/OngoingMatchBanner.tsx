import { ChevronRight } from 'lucide-react';
import { clubSync } from '../../app/remote';
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
    // Partidos que registra otro dispositivo del equipo: aquí solo se pueden ver.
    const links = await Promise.all(teams.map((t) => clubSync?.getLink(t.id) ?? null));
    const elsewhere = new Set(links.flatMap((l) => l?.controlledElsewhere ?? []));
    return lists
      .flat()
      .filter((m: Match) => m.status === 'in_progress' || m.status === 'halftime')
      .map((m) => ({ match: m, elsewhere: elsewhere.has(m.id) }));
  }, [teamId]);

  if (!ongoing.data?.length) return null;
  return (
    <div className="banner-stack">
      {ongoing.data.map(({ match: m, elsewhere }) => (
        <button key={m.id} type="button" className="banner" onClick={() => navigate({ name: 'match', matchId: m.id })}>
          <span className="banner-dot" />
          <span className="banner-text">
            <strong>
              {elsewhere ? 'En curso en otro dispositivo' : 'Partido en curso'} · vs {m.opponent}
            </strong>
            <span>
              {formatDate(m.date)} · {elsewhere ? 'toca para verlo' : 'toca para continuar'}
            </span>
          </span>
          <span className="banner-cta">
            {elsewhere ? 'Ver' : 'Continuar'}
            <Icon as={ChevronRight} size={18} />
          </span>
        </button>
      ))}
    </div>
  );
}
