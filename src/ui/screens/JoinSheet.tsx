// Unirse a un equipo del club con un código. El rol (entrenador o consulta) lo
// decide el servidor según el código; aquí no se elige. El código no se guarda
// en ningún sitio: solo se envía al canjearlo.
import { CircleCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '../../app/errors';
import { remote } from '../../app/remote';
import { navigate } from '../../app/router';
import { CODE_LENGTH, normalizeCode } from '../../remote/api';
import { ROLE_LABEL, type JoinResult } from '../../remote/session';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';

const ROLE_HELP = {
  coach: 'Como entrenador podrás registrar los partidos del equipo cuando se active la sincronización.',
  viewer: 'Con acceso de consulta puedes ver la información del equipo, pero no modificarla.',
} as const;

export function JoinSheet({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<JoinResult | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!remote || busy) return;
    setBusy(true);
    setError(null);
    try {
      setJoined(await remote.join(code));
      setCode('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (joined) {
    return (
      <Sheet
        title="Acceso concedido"
        onClose={onClose}
        footer={
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => {
              onClose();
              navigate({ name: 'remoteTeam', teamId: joined.teamId });
            }}
          >
            Ver el equipo
          </button>
        }
      >
        <div className="form">
          <p className="join-ok">
            <Icon as={CircleCheck} size={28} />
            <span>
              <strong>{joined.teamName}</strong>
              <span className="muted">
                {joined.clubName} · Temporada {joined.season}
              </span>
            </span>
          </p>
          <p>
            Permiso concedido: <span className={`status status-${joined.role}`}>{ROLE_LABEL[joined.role]}</span>
          </p>
          <p className="hint">{ROLE_HELP[joined.role]}</p>
          <p className="hint">Los equipos y partidos guardados en este dispositivo no han cambiado.</p>
        </div>
      </Sheet>
    );
  }

  const ready = normalizeCode(code).length === CODE_LENGTH;
  return (
    <Sheet
      title="Unirse con código"
      onClose={onClose}
      footer={
        <button type="submit" form="join-form" className="btn btn-primary btn-block" disabled={busy || !ready}>
          {busy ? 'Comprobando…' : 'Unirse'}
        </button>
      }
    >
      <form id="join-form" className="form" onSubmit={submit}>
        <label>
          Código
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={20}
            inputMode="text"
            enterKeyHint="go"
            autoFocus
          />
          <small>El que te ha dado el club: de entrenador o de consulta. El permiso lo determina el propio código.</small>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="hint">
          Unirse no modifica los equipos ni los partidos guardados en este dispositivo, ni sube ni descarga partidos.
        </p>
      </form>
    </Sheet>
  );
}
