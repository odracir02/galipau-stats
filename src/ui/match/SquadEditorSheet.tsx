// «Editar convocatoria» en un partido sin finalizar: añadir a quien faltaba o
// quitar a quien no ha jugado, sin tocar el cronómetro, el marcador ni las
// acciones. Quien tiene acciones en el partido (también anuladas) no se puede
// quitar. Los puestos fijos del cuerpo técnico se convocan solos al sancionarlos.
import { Check, Clipboard, Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { repo } from '../../app/repo';
import { useLoad } from '../../app/useLoad';
import { isOfficial } from '../../domain/catalog';
import { fixedSlotOf } from '../../domain/officials';
import type { Id, Match, MatchEvent, Player, Team } from '../../domain/types';
import { playersWithEvents } from '../../services/matchService';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';

interface Props {
  match: Match;
  events: readonly MatchEvent[];
  team: Team;
  onClose: () => void;
  /** Guarda la nueva convocatoria; true si se guardó. */
  onSave: (playerIds: Id[]) => Promise<boolean>;
}

interface Chip {
  id: Id;
  name: string;
  number: number;
  official: boolean;
  goalkeeper: boolean;
  /** Tiene acciones en el partido: no se puede quitar. */
  locked: boolean;
}

export function SquadEditorSheet({ match, events, team, onClose, onSave }: Props) {
  const roster = useLoad(() => repo.listPlayers(match.teamId), [match.teamId]);
  const locked = useMemo(() => playersWithEvents(events), [events]);
  const [selected, setSelected] = useState<Set<Id>>(() => new Set(match.squad.filter((s) => fixedSlotOf(s.playerId) === null).map((s) => s.playerId)));
  const [saving, setSaving] = useState(false);

  // Convocados (con la copia del partido) y, además, los activos de la plantilla.
  // Los puestos fijos no se muestran: se convocan solos al sancionarlos.
  const chips = useMemo(() => {
    const out = new Map<Id, Chip>();
    for (const s of match.squad) {
      if (fixedSlotOf(s.playerId) !== null) continue;
      out.set(s.playerId, { id: s.playerId, name: s.name, number: s.number, official: isOfficial(s), goalkeeper: s.position === 'goalkeeper', locked: locked.has(s.playerId) });
    }
    for (const p of (roster.data ?? []) as Player[]) {
      if (!p.active || fixedSlotOf(p.id) !== null || out.has(p.id)) continue;
      out.set(p.id, { id: p.id, name: p.name, number: p.number, official: isOfficial(p), goalkeeper: p.position === 'goalkeeper', locked: false });
    }
    return [...out.values()];
  }, [match.squad, roster.data, locked]);

  const byNumber = (a: Chip, b: Chip) => a.number - b.number || a.name.localeCompare(b.name, 'es');
  const groups: [string, Chip[]][] = [
    ['Jugadores de campo', chips.filter((c) => !c.official && !c.goalkeeper).sort(byNumber)],
    ['Porteros', chips.filter((c) => !c.official && c.goalkeeper).sort(byNumber)],
    ['Cuerpo técnico', chips.filter((c) => c.official).sort((a, b) => a.name.localeCompare(b.name, 'es'))],
  ];
  const players = chips.filter((c) => !c.official && selected.has(c.id)).length;
  const original = new Set(match.squad.filter((s) => fixedSlotOf(s.playerId) === null).map((s) => s.playerId));
  const changed = selected.size !== original.size || [...selected].some((id) => !original.has(id));

  const toggle = (c: Chip) => {
    if (c.locked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  };

  async function save() {
    if (saving) return;
    setSaving(true);
    const ok = await onSave([...selected]);
    if (!ok) setSaving(false);
  }

  return (
    <Sheet
      title="Editar convocatoria"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={saving || !changed} onClick={() => void save()}>
          {saving ? 'Guardando…' : 'Guardar convocatoria'}
        </button>
      }
    >
      <p className="hint">
        {players} de {team.maxSquad} convocados. El cronómetro, el marcador y las acciones no cambian. Quien ya tiene acciones en el partido no se puede quitar.
      </p>
      {roster.error && <p className="form-error">{roster.error}</p>}
      {groups.map(([title, group]) =>
        group.length === 0 ? null : (
          <section key={title}>
            <h3 className="section-title">{title}</h3>
            <div className="squad-grid">
              {group.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`squad-chip ${selected.has(c.id) ? 'on' : ''}${c.locked ? ' locked' : ''}`}
                  aria-pressed={selected.has(c.id)}
                  aria-disabled={c.locked}
                  title={c.locked ? 'Tiene acciones en este partido' : undefined}
                  onClick={() => toggle(c)}
                >
                  {c.official ? (
                    <span className="dorsal dorsal-staff" aria-hidden="true">
                      <Icon as={Clipboard} size={16} />
                    </span>
                  ) : (
                    <span className="dorsal">{c.number}</span>
                  )}
                  <span className="squad-name">{c.name}</span>
                  {c.locked ? (
                    <Icon as={Lock} size={16} className="squad-check" aria-label="Tiene acciones en este partido" />
                  ) : (
                    selected.has(c.id) && <Icon as={Check} size={18} className="squad-check" />
                  )}
                </button>
              ))}
            </div>
          </section>
        ),
      )}
      <p className="hint">Si falta alguien en la plantilla, añádelo antes en el equipo («Plantilla»); el cronómetro sigue corriendo mientras tanto.</p>
    </Sheet>
  );
}
