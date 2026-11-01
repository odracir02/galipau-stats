import { useState, type FormEvent } from 'react';
import { repo } from '../../app/repo';
import { errorMessage } from '../../app/errors';
import { isOfficial } from '../../domain/catalog';
import { newId } from '../../domain/ids';
import type { Id, Player, Position } from '../../domain/types';
import { savePlayer } from '../../services/teamService';
import { Segmented } from '../components/Segmented';
import { Sheet } from '../components/Sheet';

interface Props {
  teamId: Id;
  player?: Player;
  /** Alta de un miembro del cuerpo técnico (al editar, lo decide el propio registro). */
  official?: boolean;
  onClose: () => void;
  onSaved: (player: Player, addAnother: boolean) => void;
}

/** Alta y edición de un jugador o de un miembro del cuerpo técnico (sin dorsal ni posición). */
export function PlayerFormSheet({ teamId, player, official: newOfficial = false, onClose, onSaved }: Props) {
  const official = player ? isOfficial(player) : newOfficial;
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
        official
          ? { name, number: 0, position: 'field', active, role: 'official' }
          : { name, number: number.trim() === '' ? NaN : Number(number), position, active },
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
      title={official ? (player ? 'Editar cuerpo técnico' : 'Nuevo miembro del cuerpo técnico') : player ? 'Editar jugador' : 'Nuevo jugador'}
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
        {official ? (
          <>
            <label>
              Nombre
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus={!player} />
            </label>
            <p className="hint">Entrenador, segundo entrenador, delegado… Sin dorsal: solo aparece al registrar amarillas, exclusiones o rojas.</p>
          </>
        ) : (
          <>
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
          </>
        )}
        {player && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Activo en la plantilla
          </label>
        )}
        {player && !official && (
          <p className="hint">Los partidos ya jugados conservan el nombre y dorsal que tenía entonces.</p>
        )}
        {error && <p className="form-error">{error}</p>}
      </form>
    </Sheet>
  );
}
