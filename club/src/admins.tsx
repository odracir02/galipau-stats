// Sección «Administradores» del panel de un club: invitaciones, administradores,
// salida voluntaria y transferencia de la propiedad.
//
// Lo que se ve depende del rol que devuelve el servidor, pero los botones no son la
// protección: cada operación la vuelve a comprobar el Worker (rol en ESE club, correo
// invitado, transferencia pendiente…) y responde 403 o 404 si no corresponde. Tras
// cada operación, salga bien o mal, se vuelven a pedir la ficha del club y la cuenta.
import { ArrowRightLeft, Crown, LogOut, Mail, UserMinus, UserPlus, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ConfirmSheet } from '../../src/ui/components/Sheet';
import { ApiError, decideTransfer, inviteAdmin, leaveClub, requestTransfer, revokeAdmin, revokeInvitation } from './api';
import { formatDay, isValidEmail, normalizeEmail, ROLE_LABEL, type Account, type ClubDetail, type ClubMember } from './format';
import { ErrorBox } from './ui';

/** Zona de la pantalla donde se muestra el resultado de la última operación. */
type Area = 'members' | 'invite' | 'transfer' | 'leave';
type Outcome = { area: Area; ok: boolean; text: string };
type Confirm = { title: string; message: ReactNode; confirmLabel: string; danger?: boolean; run: () => void };

interface Props {
  account: Account;
  detail: ClubDetail;
  /** Vuelve a pedir la ficha del club y la cuenta. */
  onChanged: () => Promise<void>;
  /** La cuenta ha dejado el club: se vuelve al inicio con un aviso. */
  onLeft: (message: string) => void;
}

export function Admins({ account, detail, onChanged, onLeft }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const clubId = detail.club.id;
  const clubName = detail.club.name;
  const me = account.user.id;
  const isOwner = detail.role === 'owner';
  const active = detail.club.status === 'active';
  const transfer = detail.transfer;
  const transferTo = transfer ? detail.admins.find((a) => a.userId === transfer.toUserId) ?? null : null;
  const myMembership = detail.admins.find((a) => a.userId === me) ?? null;

  /**
   * Ejecuta una operación: estado de carga, recarga de la ficha y de la cuenta, y el
   * resultado en su zona. El mensaje aparece junto con los datos ya actualizados.
   */
  const run = async (key: string, area: Area, op: () => Promise<string | null>) => {
    setBusy(key);
    setOutcome(null);
    let result: Outcome | null;
    try {
      const text = await op();
      result = text ? { area, ok: true, text } : null;
    } catch (e) {
      result = { area, ok: false, text: e instanceof ApiError ? e.message : 'No se ha podido completar la operación.' };
    }
    await onChanged();
    setOutcome(result);
    setBusy(null);
  };

  const ask = (c: Omit<Confirm, 'run'>, action: () => void) =>
    setConfirm({
      ...c,
      run: () => {
        setConfirm(null);
        action();
      },
    });

  const shown = (area: Area) =>
    outcome?.area === area ? (
      outcome.ok ? (
        <p className="notice club-outcome" role="status">
          {outcome.text}
        </p>
      ) : (
        <ErrorBox message={outcome.text} />
      )
    ) : null;

  // --- Acciones ----------------------------------------------------------------------

  const askRevokeAdmin = (a: ClubMember) =>
    ask(
      {
        title: 'Retirar administrador',
        danger: true,
        confirmLabel: 'Retirar acceso',
        message: (
          <>
            <p>
              <strong>{a.email}</strong> dejará de tener acceso a {clubName} al instante.
            </p>
            {transfer?.toUserId === a.userId && <p>La transferencia de propiedad que tiene pendiente se cancelará.</p>}
            <p>Podrás volver a invitar a esa persona más adelante.</p>
          </>
        ),
      },
      () =>
        run(`admin:${a.userId}`, 'members', async () => {
          const r = await revokeAdmin(clubId, a.userId);
          return r.revoked ? `${a.email} ya no tiene acceso al club.` : 'Esa persona ya no tenía acceso al club.';
        }),
    );

  const askRevokeInvitation = (id: string, email: string) =>
    ask(
      {
        title: 'Retirar invitación',
        danger: true,
        confirmLabel: 'Retirar invitación',
        message: (
          <p>
            La invitación para <strong>{email}</strong> dejará de valer. Si más adelante quieres que administre el club, tendrás que
            invitarla de nuevo.
          </p>
        ),
      },
      () =>
        run(`invitation:${id}`, 'invite', async () => {
          const r = await revokeInvitation(clubId, id);
          return r.revoked ? `Invitación para ${email} retirada.` : 'Esa invitación ya estaba retirada.';
        }),
    );

  const askTransfer = (target: ClubMember) =>
    ask(
      {
        title: 'Transferir la propiedad',
        confirmLabel: 'Proponer transferencia',
        message: (
          <>
            <p>
              Vas a proponer a <strong>{target.email}</strong> como nueva persona propietaria de {clubName}.
            </p>
            <p>
              Hasta que lo acepte sigues siendo {ROLE_LABEL.owner.toLowerCase()} y puedes cancelarlo. Cuando lo acepte, pasarás a tener el
              rol de {ROLE_LABEL.admin.toLowerCase()}. La propuesta caduca a los 7 días.
            </p>
          </>
        ),
      },
      () =>
        run('transfer', 'transfer', async () => {
          await requestTransfer(clubId, target.userId);
          return `Transferencia propuesta a ${target.email}. Sigues teniendo la propiedad hasta que la acepte.`;
        }),
    );

  const cancelTransfer = (id: string) =>
    run('transfer', 'transfer', async () => {
      await decideTransfer(id, 'cancel');
      return 'Transferencia cancelada. La propiedad no ha cambiado.';
    });

  const askAcceptTransfer = (id: string) =>
    ask(
      {
        title: 'Aceptar la propiedad',
        confirmLabel: 'Aceptar la propiedad',
        message: (
          <>
            <p>Pasarás a tener la propiedad de {clubName}: podrás invitar y retirar administradores y transferirla más adelante.</p>
            <p>Quien tiene ahora la propiedad pasará a tener el rol de {ROLE_LABEL.admin.toLowerCase()}.</p>
          </>
        ),
      },
      () =>
        run('transfer', 'transfer', async () => {
          await decideTransfer(id, 'accept');
          return `Ya tienes la propiedad de ${clubName}.`;
        }),
    );

  const declineTransfer = (id: string) =>
    run('transfer', 'transfer', async () => {
      await decideTransfer(id, 'decline');
      return 'Has rechazado la transferencia. Sigues como administrador del club.';
    });

  const askLeave = () =>
    ask(
      {
        title: 'Dejar el club',
        danger: true,
        confirmLabel: 'Dejar el club',
        message: (
          <p>
            Dejarás de tener acceso a <strong>{clubName}</strong> al instante. Para volver necesitarás una invitación nueva de quien tenga
            la propiedad.
          </p>
        ),
      },
      async () => {
        setBusy('leave');
        setOutcome(null);
        try {
          await leaveClub(clubId);
          onLeft(`Has dejado de administrar ${clubName}.`);
        } catch (e) {
          await onChanged();
          setOutcome({ area: 'leave', ok: false, text: e instanceof ApiError ? e.message : 'No se ha podido completar la operación.' });
          setBusy(null);
        }
      },
    );

  // --- Vista -------------------------------------------------------------------------

  const offered = !isOwner && transfer !== null && transfer.toUserId === me;
  // Si tras la operación su tarjeta ya no está (p. ej., el rol ha cambiado mientras la
  // pantalla estaba abierta), el resultado se muestra arriba para que no se pierda.
  const visible: Record<Area, boolean> = { members: true, invite: isOwner && active, transfer: isOwner || offered, leave: !isOwner };

  return (
    <>
      {outcome && !visible[outcome.area] && shown(outcome.area)}

      {offered && transfer && (
        <section className="card club-transfer-offer" aria-labelledby="offer-title">
          <h3 id="offer-title">
            <Crown size={18} aria-hidden="true" />
            Te proponen la propiedad del club
          </h3>
          <p>
            {detail.owner ? <strong>{detail.owner.email}</strong> : 'Quien tiene la propiedad'} te propone como nueva persona propietaria de{' '}
            {clubName}. La propuesta vale hasta el {formatDay(transfer.expiresAt)}.
          </p>
          <div className="club-actions">
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => askAcceptTransfer(transfer.id)}>
              {busy === 'transfer' ? 'Guardando…' : 'Aceptar'}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => declineTransfer(transfer.id)}>
              Rechazar
            </button>
          </div>
          {shown('transfer')}
        </section>
      )}

      <section className="card club-people" aria-labelledby="people-title">
        <h3 id="people-title">Personas con acceso</h3>
        <ul className="list">
          {detail.owner && <MemberRow member={detail.owner} role="owner" me={me} />}
          {detail.admins.map((a) => (
            <MemberRow
              key={a.userId}
              member={a}
              role="admin"
              me={me}
              tag={transfer?.toUserId === a.userId && isOwner ? 'Propuesta de propiedad' : undefined}
              action={
                isOwner && active ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger-outline"
                    disabled={busy !== null}
                    onClick={() => askRevokeAdmin(a)}
                    aria-label={`Retirar a ${a.email}`}
                  >
                    <UserMinus size={16} aria-hidden="true" />
                    {busy === `admin:${a.userId}` ? 'Retirando…' : 'Retirar'}
                  </button>
                ) : undefined
              }
            />
          ))}
        </ul>
        {detail.admins.length === 0 && <p className="hint">Todavía no hay más administradores.</p>}
        {shown('members')}
      </section>

      {isOwner && !active && <p className="hint">Con el club suspendido no se pueden invitar, retirar ni cambiar administradores.</p>}

      {isOwner && active && <InviteCard clubId={clubId} busy={busy} run={run} shown={shown('invite')} />}

      {isOwner && detail.invitations.length > 0 && (
        <section className="card" aria-labelledby="pending-title">
          <h3 id="pending-title">Invitaciones pendientes</h3>
          <ul className="list">
            {detail.invitations.map((i) => (
              <li key={i.id} className="list-item">
                <Mail size={18} aria-hidden="true" className="club-row-icon" />
                <div className="list-main">
                  <strong className="club-email">{i.email}</strong>
                  <span className="muted">Pendiente · hasta el {formatDay(i.expiresAt)}</span>
                </div>
                {active && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy !== null}
                    onClick={() => askRevokeInvitation(i.id, i.email)}
                    aria-label={`Retirar la invitación de ${i.email}`}
                  >
                    <X size={16} aria-hidden="true" />
                    {busy === `invitation:${i.id}` ? 'Retirando…' : 'Retirar'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {isOwner && (
        <TransferCard
          detail={detail}
          busy={busy}
          transferTo={transferTo}
          onRequest={askTransfer}
          onCancel={cancelTransfer}
          shown={shown('transfer')}
        />
      )}

      {isOwner ? (
        <p className="hint">
          Mientras tengas la propiedad no puedes dejar el club: antes tienes que transferirla a un administrador y que la acepte.
        </p>
      ) : (
        <section className="card" aria-labelledby="leave-title">
          <h3 id="leave-title">Tu acceso</h3>
          <p className="muted">
            Administras {clubName}
            {myMembership ? ` desde el ${formatDay(myMembership.since)}` : ''}.
          </p>
          <button type="button" className="btn btn-danger-outline btn-block" disabled={busy !== null} onClick={askLeave}>
            <LogOut size={18} aria-hidden="true" />
            {busy === 'leave' ? 'Saliendo…' : 'Dejar el club'}
          </button>
          {shown('leave')}
        </section>
      )}

      {confirm && (
        <ConfirmSheet
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.run}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}

function MemberRow({ member, role, me, tag, action }: { member: ClubMember; role: 'owner' | 'admin'; me: string; tag?: string; action?: ReactNode }) {
  const mine = member.userId === me;
  return (
    <li className="list-item club-member">
      <div className="list-main">
        <strong className="club-email">
          {member.email}
          {mine && <span className="club-you"> (tú)</span>}
        </strong>
        <span className="muted">
          Activo · desde el {formatDay(member.since)}
          {tag ? ` · ${tag}` : ''}
        </span>
      </div>
      <span className={`status club-role club-role-${role}`}>{ROLE_LABEL[role]}</span>
      {action}
    </li>
  );
}

function InviteCard({
  clubId,
  busy,
  run,
  shown,
}: {
  clubId: string;
  busy: string | null;
  run: (key: string, area: Area, op: () => Promise<string | null>) => Promise<void>;
  shown: ReactNode;
}) {
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!isValidEmail(email)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const target = normalizeEmail(email);
    void run('invite', 'invite', async () => {
      const r = await inviteAdmin(clubId, target);
      setEmail('');
      return r.created
        ? `Invitación creada para ${r.invitation.email}. La persona podrá aceptarla al acceder con este correo cuando tenga disponible el acceso.`
        : `Ya había una invitación pendiente para ${r.invitation.email}. Sigue siendo válida hasta el ${formatDay(r.invitation.expiresAt)}.`;
    });
  };

  return (
    <form className="card form club-invite" onSubmit={submit} noValidate aria-labelledby="invite-title">
      <h3 id="invite-title">
        <UserPlus size={18} aria-hidden="true" />
        Invitar a un administrador
      </h3>
      <label>
        Correo de la persona
        <input
          type="email"
          inputMode="email"
          autoComplete="off"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setInvalid(false);
          }}
          placeholder="nombre@ejemplo.com"
          maxLength={254}
          aria-invalid={invalid || undefined}
          aria-describedby="invite-hint"
        />
      </label>
      <small id="invite-hint" className="hint">
        La invitación queda ligada a este correo y vale 7 días. GalipauStats todavía no envía avisos por correo: díselo tú a esa persona.
      </small>
      {invalid && <ErrorBox message="Escribe un correo válido." />}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy !== null || !email.trim()}>
        {busy === 'invite' ? 'Creando invitación…' : 'Crear invitación'}
      </button>
      {shown}
    </form>
  );
}

function TransferCard({
  detail,
  busy,
  transferTo,
  onRequest,
  onCancel,
  shown,
}: {
  detail: ClubDetail;
  busy: string | null;
  transferTo: ClubMember | null;
  onRequest: (target: ClubMember) => void;
  onCancel: (id: string) => void;
  shown: ReactNode;
}) {
  const [target, setTarget] = useState('');
  const transfer = detail.transfer;
  const active = detail.club.status === 'active';
  const chosen = detail.admins.find((a) => a.userId === target) ?? null;

  return (
    <section className="card club-transfer" aria-labelledby="transfer-title">
      <h3 id="transfer-title">
        <ArrowRightLeft size={18} aria-hidden="true" />
        Transferir la propiedad
      </h3>
      {transfer ? (
        <>
          <p className="club-transfer-state" role="status">
            Pendiente de aceptar por <strong className="club-email">{transferTo?.email ?? 'un administrador'}</strong> hasta el{' '}
            {formatDay(transfer.expiresAt)}. Mientras tanto, la propiedad sigue siendo tuya.
          </p>
          <button type="button" className="btn btn-block" disabled={busy !== null} onClick={() => onCancel(transfer.id)}>
            {busy === 'transfer' ? 'Cancelando…' : 'Cancelar transferencia'}
          </button>
        </>
      ) : detail.admins.length === 0 ? (
        <p className="muted">Para transferir la propiedad, antes tiene que haber al menos un administrador en el club.</p>
      ) : !active ? (
        <p className="muted">Con el club suspendido no se puede transferir la propiedad.</p>
      ) : (
        <>
          <p className="muted">
            Solo se puede transferir a un administrador del club, y no cambia nada hasta que lo acepte. Tú pasarías a tener el rol de
            administrador.
          </p>
          <label>
            Nueva persona propietaria
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Elige un administrador</option>
              {detail.admins.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-block" disabled={busy !== null || !chosen} onClick={() => chosen && onRequest(chosen)}>
            {busy === 'transfer' ? 'Guardando…' : 'Proponer transferencia'}
          </button>
        </>
      )}
      {shown}
    </section>
  );
}
