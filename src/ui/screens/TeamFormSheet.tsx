import { useState, type FormEvent } from 'react';
import { repo } from '../../app/repo';
import { errorMessage } from '../../app/errors';
import { newId } from '../../domain/ids';
import { seasonFor } from '../../domain/format';
import type { Team } from '../../domain/types';
import { createTeam, DEFAULT_MAX_SQUAD, updateTeam } from '../../services/teamService';
import { Sheet } from '../components/Sheet';

interface Props {
  team?: Team;
  onClose: () => void;
  onSaved: (team: Team) => void;
}

export function TeamFormSheet({ team, onClose, onSaved }: Props) {
  const [name, setName] = useState(team?.name ?? '');
  const [code, setCode] = useState(team?.code ?? '');
  const [season, setSeason] = useState(team?.season ?? seasonFor());
  const [maxSquad, setMaxSquad] = useState(String(team?.maxSquad ?? DEFAULT_MAX_SQUAD));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Id fijado al abrir el formulario: una doble pulsación no crea dos equipos.
  const [draftId] = useState(newId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const input = { name, code, season, maxSquad: Number(maxSquad) };
      onSaved(team ? await updateTeam(repo, team, input) : await createTeam(repo, input, draftId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      title={team ? 'Editar equipo' : 'Nuevo equipo'}
      onClose={onClose}
      footer={
        <button type="submit" form="team-form" className="btn btn-primary btn-block" disabled={saving}>
          Guardar
        </button>
      }
    >
      <form id="team-form" className="form" onSubmit={submit}>
        <label>
          Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Senior Masculino" autoFocus />
        </label>
        <label>
          Código corto
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="SM2627"
            autoCapitalize="characters"
            autoComplete="off"
          />
          <small>Identifica el equipo. No es una contraseña.</small>
        </label>
        <div className="form-row">
          <label>
            Temporada
            <input value={season} onChange={(e) => setSeason(e.target.value)} placeholder="2026/27" />
          </label>
          <label>
            Máx. convocados
            <input
              value={maxSquad}
              onChange={(e) => setMaxSquad(e.target.value)}
              inputMode="numeric"
              type="number"
              min={1}
              max={40}
            />
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
    </Sheet>
  );
}
