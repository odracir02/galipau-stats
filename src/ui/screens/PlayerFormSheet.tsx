import { useState, type FormEvent } from 'react';
import { repo } from '../../app/repo';
import { errorMessage } from '../../app/errors';
import { newId } from '../../domain/ids';
import type { Id, Player, Position } from '../../domain/types';
import { savePlayer } from '../../services/teamService';
import { Segmented } from '../components/Segmented';
import { Sheet } from '../components/Sheet';

interface Props {
  teamId: Id;
  player?: Player;
  onClose: () => void;
  onSaved: (player: Player, addAnother: boolean) => void;
}

export function PlayerFormSheet({ teamId, player, onClose, onSaved }: Props) {
  const [name, setName] = useState(player?.name ?? '');
  const [number, setNumber] = useState(player ? String(player.number) : '');
  const [position, setPosition] = useState<Position>(player?.position ?? 'field');
  const [active, setActive] = useState(player?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftId] = useState(newId);

  async function save(addAnother: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await savePlayer(
        repo,
        teamId,
        { name, number: number.trim() === '' ? NaN : Number(number), position, active },
        player,
        draftId,
      );
      onSaved(saved, addAnother);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  return (
    <Sheet
      title={player ? 'Editar jugador' : 'Nuevo jugador'}
      onClose={onClose}
      footer={
        <>
          {!player && (
            <button type="button" className="btn" disabled={saving} onClick={() => void save(true)}>
              Guardar y añadir otro
            </button>
          )}
          <button type="submit" form="player-form" className="btn btn-primary" disabled={saving}>
            Guardar
          </button>
        </>
      }
    >
      <form id="player-form" className="form" onSubmit={submit}>
        <div className="form-row form-row-number">
          <label>
            Dorsal
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 2))}
              inputMode="numeric"
              autoFocus={!player}
            />
          </label>
          <label>
            Nombre
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
        </div>
        <Segmented
          ariaLabel="Posición"
          value={position}
          onChange={setPosition}
          options={[
            { value: 'field', label: 'Jugador de campo' },
            { value: 'goalkeeper', label: 'Portero' },
          ]}
        />
        {player && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Activo en la plantilla
          </label>
        )}
        {player && (
          <p className="hint">Los partidos ya jugados conservan el nombre y dorsal que tenía entonces.</p>
        )}
        {error && <p className="form-error">{error}</p>}
      </form>
    </Sheet>
  );
}
