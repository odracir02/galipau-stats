// Vincular un equipo local con un equipo del club. Nunca se elige solo: aunque
// los códigos coincidan, el usuario selecciona el equipo y confirma.
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../app/errors';
import { clubSync } from '../../app/remote';
import type { Team } from '../../domain/types';
import type { RemoteTeam } from '../../remote/api';
import type { RosterCoincidence } from '../../remote/rosterCheck';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function LinkSheet({ team, onClose, onLinked }: { team: Team; onClose: () => void; onLinked: () => void }) {
  const [candidates, setCandidates] = useState<RemoteTeam[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Comprobación de la plantilla del club antes de vincular (null: comprobando; 'failed': no se pudo). */
  const [check, setCheck] = useState<{ for: string; result: { clubPlayers: number; coincidences: RosterCoincidence[] } | 'failed' } | null>(null);

  useEffect(() => {
    void clubSync?.linkCandidates().then(setCandidates, (e: unknown) => setError(errorMessage(e)));
  }, []);

  const remote = candidates?.find((c) => c.teamId === selected) ?? null;

  useEffect(() => {
    if (!confirming || !remote || !clubSync) return;
    let alive = true;
    clubSync.linkCheck(team.id, remote.teamId).then(
      (result) => alive && setCheck({ for: remote.teamId, result }),
      () => alive && setCheck({ for: remote.teamId, result: 'failed' }),
    );
    return () => {
      alive = false;
    };
  }, [confirming, remote, team.id]);

  if (confirming && remote) {
    const warnings = [
      remote.season !== team.season && `La temporada es distinta (${team.season} aquí, ${remote.season} en el club).`,
      remote.code !== team.code && `El código es distinto (${team.code} aquí, ${remote.code} en el club).`,
    ].filter(Boolean) as string[];
    const result = check?.for === remote.teamId ? check.result : null;
    const coincidences = result && result !== 'failed' ? result.coincidences : [];
    return (
      <Sheet
        title="Confirmar vínculo"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>
              Volver
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || result === null}
              onClick={async () => {
                setBusy(true);
                try {
                  await clubSync?.link(team.id, remote.teamId);
                  onLinked();
                } catch (e) {
                  setError(errorMessage(e));
                  setConfirming(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {coincidences.length > 0 ? 'Vincular igualmente' : 'Vincular'}
            </button>
          </>
        }
      >
        <div className="form">
          <LinkPair team={team} remote={remote} />
          {warnings.map((w) => (
            <p key={w} className="notice">
              <Icon as={TriangleAlert} size={18} />
              {w}
            </p>
          ))}
          {result === null && <p className="hint">Comprobando la plantilla del club…</p>}
          {result === 'failed' && (
            <p className="notice">
              <Icon as={TriangleAlert} size={18} />
              No se ha podido comprobar la plantilla del club. Si el club ya tiene fichas con los mismos dorsales que este equipo,
              quedarán repetidas al vincular.
            </p>
          )}
          {coincidences.length > 0 && (
            <div className="notice link-clash">
              <Icon as={TriangleAlert} size={18} />
              <div>
                <p>
                  <strong>
                    El club ya tiene {plural(coincidences.length, 'ficha', 'fichas')} con el mismo dorsal que {coincidences.length === 1 ? 'una' : 'otras'} de este
                    equipo:
                  </strong>
                </p>
                <ul>
                  {coincidences.map((c) => (
                    <li key={c.local.id}>
                      {c.number}: «{c.local.name}» aquí y «{c.club.name}» en el club{c.sameName ? ' (mismo nombre)' : ''}
                    </li>
                  ))}
                </ul>
                <p>
                  Si vinculas, el club no aceptará las de aquí y, al recibir las del club, quedarán dorsales repetidos: el envío se
                  detendrá hasta corregirlos en «Plantilla» («Corregir ficha»: unir si es la misma persona; si no, cambiar el dorsal).
                  Si el club ya tiene este equipo con su plantilla, quizá sea mejor no vincular y usar el equipo del club.
                </p>
              </div>
            </div>
          )}
          <p className="hint">
            Vincular no envía nada al servidor y no cambia los datos de este dispositivo. Un equipo solo se puede vincular con
            uno del club.
          </p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Vincular con el club"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary btn-block" disabled={!remote} onClick={() => setConfirming(true)}>
          Continuar
        </button>
      }
    >
      <div className="form">
        <p className="field-label">Equipo de este dispositivo</p>
        <TeamBox name={team.name} code={team.code} season={team.season} />
        <p className="field-label">Equipo del club</p>
        {candidates === null && !error && <p className="hint">Cargando…</p>}
        {candidates?.length === 0 && (
          <p className="empty">No hay equipos del club libres en los que tengas permiso de entrenador.</p>
        )}
        <div className="link-options" role="radiogroup" aria-label="Equipo del club">
          {candidates?.map((c) => (
            <label key={c.teamId} className={`link-option ${selected === c.teamId ? 'on' : ''}`}>
              <input type="radio" name="remote-team" checked={selected === c.teamId} onChange={() => setSelected(c.teamId)} />
              <TeamBox name={c.name} code={c.code} season={c.season} club={c.clubName} />
            </label>
          ))}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}

function TeamBox({ name, code, season, club }: { name: string; code: string; season: string; club?: string }) {
  return (
    <span className="team-box">
      <strong>{name}</strong>
      <span className="muted">
        {club ? `${club} · ` : ''}
        {code} · Temporada {season}
      </span>
    </span>
  );
}

function LinkPair({ team, remote }: { team: Team; remote: RemoteTeam }) {
  return (
    <div className="link-pair">
      <span className="field-label">Este dispositivo</span>
      <TeamBox name={team.name} code={team.code} season={team.season} />
      <span className="link-arrow" aria-hidden="true">
        ↓
      </span>
      <span className="field-label">Club</span>
      <TeamBox name={remote.name} code={remote.code} season={remote.season} club={remote.clubName} />
    </div>
  );
}
