// Sesión de este dispositivo con el servidor: equipos a los que tiene acceso y
// cerrar la sesión. Cerrarla retira el acceso a todos los equipos del club en
// este dispositivo; los equipos y partidos guardados en él no se tocan.
import { useState } from 'react';
import { errorMessage } from '../../app/errors';
import { remote } from '../../app/remote';
import { showToast } from '../../app/toast';
import { useRemote } from '../../app/useRemote';
import { formatChecked, ROLE_LABEL } from '../../remote/session';
import { ConfirmSheet, Sheet } from '../components/Sheet';

export function DeviceSessionSheet({ onClose }: { onClose: () => void }) {
  const state = useRemote(remote);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (confirming) {
    return (
      <ConfirmSheet
        title="Cerrar sesión"
        message={
          <>
            <p>Este dispositivo dejará de tener acceso a los equipos del club. Para volver necesitarás un código.</p>
            <p>Los equipos y partidos guardados en este dispositivo no se borran ni cambian.</p>
          </>
        }
        confirmLabel="Cerrar sesión"
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          try {
            await remote?.logout();
            showToast('Sesión cerrada', 'info');
            onClose();
          } catch (e) {
            setConfirming(false);
            setError(errorMessage(e));
          }
        }}
      />
    );
  }

  return (
    <Sheet title="Sesión de este dispositivo" onClose={onClose}>
      <div className="form">
        <dl className="kv">
          {state.teams.map((t) => (
            <div key={t.teamId} className="kv-row">
              <dt>
                {t.name} · {t.clubName}
              </dt>
              <dd>{ROLE_LABEL[t.role]}</dd>
            </div>
          ))}
        </dl>
        {state.checkedAt && <p className="hint">Última comprobación con el servidor: {formatChecked(state.checkedAt)}.</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="hint">
          Cerrar la sesión necesita conexión: así el servidor retira de verdad el acceso de este dispositivo.
        </p>
        <button type="button" className="btn btn-danger-outline btn-block" onClick={() => setConfirming(true)}>
          Cerrar sesión en este dispositivo
        </button>
      </div>
    </Sheet>
  );
}
