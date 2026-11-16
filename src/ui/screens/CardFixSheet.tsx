// «Corregir ficha»: borrar una ficha repetida sin actividad o unirla con la
// otra ficha de la misma persona. Siempre lo elige el entrenador (nunca por
// nombre ni dorsal) y siempre con una confirmación que dice qué pasará.
import { useState } from 'react';
import { isPlayerOnClub } from '../../app/remote';
import { repo } from '../../app/repo';
import { errorMessage } from '../../app/errors';
import { useLoad } from '../../app/useLoad';
import { isOfficial } from '../../domain/catalog';
import type { Id, Player } from '../../domain/types';
import { cardActivity, deletePlayerCard, mergePlayerCards, planMerge, type CardActivity, type MergePlan } from '../../services/rosterService';
import { ConfirmSheet, Sheet } from '../components/Sheet';

interface Props {
  player: Player;
  onClose: () => void;
  /** Tras borrar o unir: `kept` es la ficha que queda (si se unió). */
  onDone: (message: string) => void;
}

const card = (p: Player) => `${p.number} · ${p.name}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const usage = (a: CardActivity | undefined) =>
  !a || (a.matches === 0 && a.events === 0) ? 'sin partidos' : `${plural(a.matches, 'partido', 'partidos')}, ${plural(a.events, 'acción', 'acciones')}`;

export function CardFixSheet({ player, onClose, onDone }: Props) {
  const data = useLoad(async () => {
    const [players, activity] = await Promise.all([repo.listPlayers(player.teamId), cardActivity(repo, player.teamId)]);
    const others = players.filter((p) => p.id !== player.id && !isOfficial(p));
    const onClub = new Map<Id, boolean>(await Promise.all([player, ...others].map(async (p) => [p.id, await isPlayerOnClub(p.id)] as const)));
    // Primero las del mismo dorsal; después el resto por dorsal.
    others.sort((a, b) => Number(b.number === player.number) - Number(a.number === player.number) || a.number - b.number || a.name.localeCompare(b.name, 'es'));
    return { others, activity, onClub };
  }, [player.id]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'delete' } | { kind: 'merge'; plan: MergePlan } | null>(null);

  const mine = data.data?.activity.get(player.id);
  const mineOnClub = data.data?.onClub.get(player.id) ?? false;
  const canDelete = data.data !== undefined && !mineOnClub && (mine?.matches ?? 0) === 0 && (mine?.events ?? 0) === 0;
  const where = (id: Id) => (data.data?.onClub.get(id) ? 'en el club' : 'solo en este dispositivo');

  async function run(op: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await op());
    } catch (err) {
      setError(errorMessage(err));
      setConfirm(null);
      setBusy(false);
    }
  }

  async function askMerge(other: Player) {
    setError(null);
    try {
      // Si ninguna está en el club, se conserva la que tiene más actividad (si empatan, la abierta).
      const a = data.data?.activity;
      const prefer = (a?.get(other.id)?.events ?? 0) > (a?.get(player.id)?.events ?? 0) ? other : player;
      setConfirm({ kind: 'merge', plan: await planMerge(repo, player, other, isPlayerOnClub, prefer) });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <Sheet title="Corregir ficha" onClose={onClose}>
        <p>
          <strong>{card(player)}</strong>
          <br />
          <span className="muted">
            {data.data ? `${usage(mine)} · ${where(player.id)}` : 'Comprobando…'}
          </span>
        </p>
        {data.error && <p className="form-error">{data.error}</p>}
        {error && <p className="form-error">{error}</p>}

        <h3 className="section-title">Borrar esta ficha</h3>
        {canDelete ? (
          <>
            <p className="hint">No aparece en ningún partido ni ha llegado al club: se puede borrar sin perder nada.</p>
            <button type="button" className="btn btn-danger-outline btn-block" disabled={busy} onClick={() => setConfirm({ kind: 'delete' })}>
              Borrar ficha
            </button>
          </>
        ) : (
          <p className="hint">
            {mineOnClub
              ? 'Ya está en el club: no se puede borrar. Para que no salga en partidos nuevos, desmarca «Activo en la plantilla».'
              : 'Aparece en partidos: no se puede borrar. Si es la misma persona que otra ficha, únelas.'}
          </p>
        )}

        <h3 className="section-title">Unir con otra ficha de la misma persona</h3>
        <p className="hint">
          Para cuando la misma jugadora o el mismo jugador está dos veces. La ficha que ya está en el club se conserva; la otra desaparece y sus partidos y acciones pasan a la que queda. Solo si estás seguro de que es la misma persona.
        </p>
        {data.data && data.data.others.length === 0 && <p className="empty">No hay otras fichas en la plantilla.</p>}
        <ul className="list">
          {data.data?.others.map((o) => (
            <li key={o.id}>
              <button type="button" className={`list-item ${o.active ? '' : 'inactive'}`} disabled={busy} onClick={() => void askMerge(o)}>
                <span className="dorsal">{o.number}</span>
                <span className="list-main">
                  <strong>{o.name}</strong>
                  <span className="muted">
                    {usage(data.data!.activity.get(o.id))} · {where(o.id)}
                    {!o.active && ' · inactiva'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
      {confirm?.kind === 'delete' && (
        <ConfirmSheet
          title="Borrar ficha"
          danger
          confirmLabel={busy ? 'Borrando…' : 'Borrar ficha'}
          message={<p>Se borrará la ficha <strong>{card(player)}</strong> de este dispositivo. No aparece en ningún partido.</p>}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run(async () => {
              await deletePlayerCard(repo, player, isPlayerOnClub);
              return `Ficha ${card(player)} borrada`;
            })
          }
        />
      )}
      {confirm?.kind === 'merge' && (
        <ConfirmSheet
          title="Unir fichas"
          confirmLabel={busy ? 'Uniendo…' : 'Unir fichas'}
          message={
            <>
              <p>
                Se conserva <strong>{card(confirm.plan.keep)}</strong> ({where(confirm.plan.keep.id)}).
              </p>
              <p>
                Desaparece <strong>{card(confirm.plan.remove)}</strong> ({where(confirm.plan.remove.id)}): {plural(confirm.plan.matches.length, 'partido pasa', 'partidos pasan')} y {plural(confirm.plan.events.length, 'acción pasa', 'acciones pasan')} a la ficha que se conserva.
              </p>
              <p className="hint">Los partidos conservan el nombre y el dorsal con los que se jugaron. No se puede deshacer.</p>
            </>
          }
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run(async () => {
              const kept = await mergePlayerCards(repo, confirm.plan, isPlayerOnClub);
              return `Fichas unidas en ${card(kept)}`;
            })
          }
        />
      )}
    </>
  );
}
