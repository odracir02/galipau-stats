import { useState, type FormEvent } from 'react';
import { repo } from '../../app/repo';
import { navigate } from '../../app/router';
import { errorMessage } from '../../app/errors';
import { useLoad } from '../../app/useLoad';
import { todayLocal } from '../../domain/format';
import { newId } from '../../domain/ids';
import type { Id, Player, Team, Venue } from '../../domain/types';
import { createMatch, previousSquadIds } from '../../services/matchService';
import { Segmented } from '../components/Segmented';
import { TopBar } from '../components/TopBar';

export function NewMatchScreen({ teamId }: { teamId: Id }) {
  const data = useLoad(async () => {
    const [team, players, previous] = await Promise.all([
      repo.getTeam(teamId),
      repo.listPlayers(teamId),
      previousSquadIds(repo, teamId),
    ]);
    return { team, players: players.filter((p) => p.active), previous };
  }, [teamId]);

  if (data.error) return <p className="form-error">{data.error}</p>;
  if (!data.data) return <div className="screen" />;
  const { team, players, previous } = data.data;
  if (!team) return <p className="form-error">Equipo no encontrado.</p>;
  // Propuesta inicial: convocatoria del último partido (solo jugadores aún activos).
  const activeIds = new Set(players.map((p) => p.id));
  const proposal = previous.filter((id) => activeIds.has(id));
  return <NewMatchForm team={team} players={players} proposal={proposal} />;
}

function NewMatchForm({ team, players, proposal }: { team: Team; players: Player[]; proposal: Id[] }) {
  const teamId = team.id;
  const [opponent, setOpponent] = useState('');
  const [date, setDate] = useState(todayLocal);
  const [venue, setVenue] = useState<Venue>('home');
  const [season, setSeason] = useState(team.season);
  const [selected, setSelected] = useState<Set<Id>>(() => new Set(proposal));
  const usedPrevious = proposal.length > 0;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Id fijado al abrir: una doble pulsación o un reintento no duplican el partido.
  const [matchId] = useState(newId);

  const max = team.maxSquad;
  const field = players.filter((p) => p.position === 'field');
  const gks = players.filter((p) => p.position === 'goalkeeper');
  const nField = field.filter((p) => selected.has(p.id)).length;
  const nGk = gks.filter((p) => selected.has(p.id)).length;
  const total = nField + nGk;

  const toggle = (id: Id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const match = await createMatch(
        repo,
        { teamId, opponent, date, venue, season, playerIds: [...selected] },
        matchId,
      );
      navigate({ name: 'match', matchId: match.id }, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const renderGroup = (title: string, group: Player[]) => (
    <section>
      <h3 className="section-title">{title}</h3>
      {group.length === 0 && <p className="empty">No hay {title.toLowerCase()} activos en la plantilla.</p>}
      <div className="squad-grid">
        {group.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`squad-chip ${selected.has(p.id) ? 'on' : ''}`}
            aria-pressed={selected.has(p.id)}
            onClick={() => toggle(p.id)}
          >
            <span className="dorsal">{p.number}</span>
            <span className="squad-name">{p.name}</span>
          </button>
        ))}
      </div>
    </section>
  );

  return (
    <div className="screen">
      <TopBar title="Nuevo partido" subtitle={team.name} back={() => navigate({ name: 'team', teamId })} />
      <form className="content form" onSubmit={submit}>
        <label>
          Equipo contrario
          <input value={opponent} onChange={(e) => setOpponent(e.target.value)} placeholder="Rival" autoComplete="off" />
        </label>
        <div className="form-row">
          <label>
            Fecha
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Temporada
            <input value={season} onChange={(e) => setSeason(e.target.value)} />
          </label>
        </div>
        <Segmented
          ariaLabel="Local o visitante"
          value={venue}
          onChange={setVenue}
          options={[
            { value: 'home', label: 'Local' },
            { value: 'away', label: 'Visitante' },
          ]}
        />

        <div className="squad-head">
          <strong>Convocatoria</strong>
          <span className={total > max ? 'over' : 'muted'}>
            {nField} campo + {nGk} porteros = {total}/{max}
          </span>
        </div>
        {usedPrevious && (
          <p className="hint">
            Propuesta: convocatoria del último partido.{' '}
            <button type="button" className="link" onClick={() => setSelected(new Set())}>
              Vaciar
            </button>
          </p>
        )}
        {players.length === 0 && (
          <p className="notice">
            La plantilla está vacía. Añade jugadores desde la pestaña «Plantilla» del equipo.
          </p>
        )}
        {renderGroup('Porteros', gks)}
        {renderGroup('Jugadores de campo', field)}

        {error && <p className="form-error">{error}</p>}
        <div className="sticky-foot">
          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={saving || total === 0 || total > max}>
            Crear partido
          </button>
        </div>
      </form>
    </div>
  );
}
