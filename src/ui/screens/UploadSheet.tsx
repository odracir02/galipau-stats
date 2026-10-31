// Envío manual al servidor del club: previsualización, confirmación, progreso y
// resultado comprobado. Solo se habla de «Sincronización completada» cuando el
// servidor coincide con este dispositivo. Los datos locales no cambian nunca.
import { CircleCheck, CloudUpload, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../app/errors';
import { clubSync } from '../../app/remote';
import { formatDate } from '../../domain/format';
import type { Team } from '../../domain/types';
import type { UploadPlan } from '../../remote/plan';
import type { UploadOutcome, UploadProgress } from '../../remote/upload';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { KV } from '../stats/StatTables';

const PHASE: Record<UploadProgress['phase'], string> = {
  players: 'Jugadores',
  matches: 'Partidos y convocatorias',
  events: 'Acciones',
  verify: 'Comprobando con el servidor',
};

const STOP_HELP: Record<NonNullable<UploadOutcome['stop']>['reason'], string> = {
  offline: 'Se ha perdido la conexión. Vuelve a enviar cuando tengas internet: lo ya enviado no se repite.',
  unauthorized: 'La sesión de este dispositivo ya no es válida. Únete de nuevo con el código de entrenador.',
  forbidden: 'Este dispositivo no tiene permiso de entrenador en ese equipo del club.',
  conflict: 'El servidor tiene otra versión de este dato. No se ha sobrescrito nada; hay que revisarlo antes de seguir.',
  recorded_elsewhere: 'Otro dispositivo registra ese partido. No se ha sobrescrito nada.',
  rejected: 'El servidor no ha aceptado este dato. No se ha transformado nada.',
};

type Step = 'preview' | 'confirm' | 'running' | 'done';

export function UploadSheet({ team, onClose }: { team: Team; onClose: () => void }) {
  const [plan, setPlan] = useState<UploadPlan | null>(null);
  const [firstTime, setFirstTime] = useState(true);
  const [step, setStep] = useState<Step>('preview');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clubSync) return;
    void clubSync.preview(team.id).then(
      async (p) => {
        setPlan(p);
        setFirstTime(!(await clubSync!.hasSent(p.link)));
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [team.id]);

  async function send() {
    if (!clubSync) return;
    setStep('running');
    setError(null);
    try {
      setOutcome(await clubSync.upload(team.id, setProgress));
    } catch (e) {
      setError(errorMessage(e));
    }
    setStep('done');
  }

  const running = step === 'running';
  const close = running ? () => undefined : onClose;
  const s = plan?.summary;

  if (step === 'confirm' && plan) {
    return (
      <Sheet
        title="Primer envío"
        onClose={() => setStep('preview')}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setStep('preview')}>
              Volver
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void send()}>
              Enviar
            </button>
          </>
        }
      >
        <div className="form">
          <p>
            Se enviarán al servidor del club los datos de <strong>{team.name}</strong>: {s!.players} jugadores, {s!.matches} partidos y{' '}
            {s!.events} acciones, con destino <strong>{plan.link.remoteTeamName}</strong> ({plan.link.clubName}).
          </p>
          <p className="hint">
            Las personas con acceso a ese equipo del club podrán verlos. Los datos de este dispositivo no cambian. Si el envío se
            interrumpe, puedes repetirlo sin duplicar nada.
          </p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Enviar al servidor"
      onClose={close}
      footer={
        step === 'preview' ? (
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!plan || plan.problems.length > 0}
            onClick={() => (firstTime ? setStep('confirm') : void send())}
          >
            <Icon as={CloudUpload} />
            Enviar al servidor
          </button>
        ) : step === 'done' ? (
          <button type="button" className="btn btn-block" onClick={onClose}>
            Cerrar
          </button>
        ) : undefined
      }
    >
      <div className="form">
        {!plan && !error && <p className="hint">Preparando…</p>}
        {plan && step === 'preview' && (
          <>
            <dl className="kv">
              <KV k="Origen (este dispositivo)" v={`${team.name} · ${team.code} · ${team.season}`} />
              <KV k="Destino (club)" v={`${plan.link.remoteTeamName} · ${plan.link.clubName} · ${plan.link.remoteSeason}`} />
              <KV k="Jugadores" v={s!.inactivePlayers ? `${s!.players} (${s!.inactivePlayers} inactivos)` : s!.players} />
              <KV k="Partidos" v={s!.matches} />
              <KV k="Convocatorias" v={`${s!.matches} (${s!.squadEntries} convocados)`} />
              <KV k="Acciones" v={s!.events} />
              <KV k="· borradas (se envían marcadas)" v={s!.deletedEvents} />
              <KV k="· pendientes de atribuir" v={s!.pendingEvents} />
              <KV k="· golpes francos" v={s!.freeThrows} />
              <KV k="· sanciones adicionales (4 min)" v={s!.additionalSanctions} />
              <KV k="Partidos con corrección de marcador" v={s!.scoreCorrections} />
              {s!.matchDeletions > 0 && <KV k="Partidos eliminados aquí (se retiran del club)" v={s!.matchDeletions} />}
            </dl>
            {plan.skippedMatches.length > 0 && (
              <p className="hint">
                {plan.skippedMatches.length === 1 ? 'No se envía 1 partido eliminado' : `No se envían ${plan.skippedMatches.length} partidos eliminados`}{' '}
                en este dispositivo ({plan.skippedMatches.map((m) => `vs ${m.opponent} ${formatDate(m.date)}`).join(', ')}) ni{' '}
                {s!.skippedEvents === 1 ? 'su acción' : `sus ${s!.skippedEvents} acciones`}. Siguen guardados aquí.
              </p>
            )}
            {plan.problems.length > 0 ? (
              <div className="warning" role="alert">
                <Icon as={TriangleAlert} />
                <div>
                  <strong>El servidor no aceptaría estos datos</strong>
                  <ul className="problem-list">
                    {plan.problems.slice(0, 12).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  {plan.problems.length > 12 && <p className="muted">Y {plan.problems.length - 12} más.</p>}
                  <p className="muted">No se envía nada. Corrige estos datos en el equipo y vuelve a intentarlo.</p>
                </div>
              </div>
            ) : (
              <p className="notice">
                <Icon as={CloudUpload} size={18} />
                Se enviarán estos datos al servidor del club. Los datos de este dispositivo no cambian.
              </p>
            )}
          </>
        )}
        {running && (
          <div className="upload-progress" role="status" aria-live="polite">
            <strong>{progress ? PHASE[progress.phase] : 'Empezando…'}</strong>
            {progress && progress.phase !== 'verify' && (
              <span className="muted">
                {progress.done} de {progress.total}
              </span>
            )}
            <span className="hint">No cierres la app hasta que termine.</span>
          </div>
        )}
        {step === 'done' && outcome && <Result outcome={outcome} />}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}

function Result({ outcome }: { outcome: UploadOutcome }) {
  const { sent, unchanged } = outcome;
  const counts = `${sent.players} jugadores, ${sent.matches} partidos y ${sent.events} acciones enviados${unchanged ? `; ${unchanged} ya estaban al día` : ''}.`;
  if (outcome.status === 'verified') {
    return (
      <div className="upload-result ok">
        <Icon as={CircleCheck} size={28} />
        <div>
          <strong>Sincronización completada</strong>
          <p>{counts}</p>
          <p className="hint">El servidor coincide con este dispositivo: jugadores, partidos, acciones, resultados y estadísticas.</p>
          {(outcome.setAside ?? 0) > 0 && (
            <p className="hint">
              {outcome.setAside} {outcome.setAside === 1 ? 'dato no se ha enviado' : 'datos no se han enviado'}: están en conflicto o son de un
              partido que registra otro dispositivo. Se conservan en este dispositivo.
            </p>
          )}
        </div>
      </div>
    );
  }
  if (outcome.status === 'differences') {
    return (
      <div className="warning" role="alert">
        <Icon as={TriangleAlert} />
        <div>
          <strong>Enviado, pero el servidor no coincide</strong>
          <p>{counts}</p>
          <ul className="problem-list">
            {outcome.differences.slice(0, 12).map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <p className="muted">Los datos de este dispositivo no han cambiado.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="warning" role="alert">
      <Icon as={TriangleAlert} />
      <div>
        <strong>Envío detenido</strong>
        <p>
          {outcome.stop!.record}: {outcome.stop!.message}
        </p>
        <p>{STOP_HELP[outcome.stop!.reason]}</p>
        <p className="muted">{counts} Los datos de este dispositivo no han cambiado.</p>
      </div>
    </div>
  );
}
