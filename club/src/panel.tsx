// Inicio (clubes e invitaciones) y panel de cada club. Lo que muestra lo decide el
// servidor en cada petición: rol, clubes y equipos llegan de la API; la interfaz no
// guarda ni deduce permisos.
import { Building2, Check, ChevronRight, Crown, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Admins } from './admins';
import { answerInvitation, ApiError, getClub, getTeams } from './api';
import {
  clubHash,
  formatDay,
  GENDER_LABEL,
  ROLE_LABEL,
  SECTION_LABEL,
  SECTIONS,
  seasonsOf,
  type Account,
  type ClubDetail,
  type PublicConfig,
  type Section,
  type TeamSummary,
} from './format';
import { go } from './nav';
import { ComingSoon, ErrorBox, Loading } from './ui';

// --- Inicio --------------------------------------------------------------------------

export function Home({
  account,
  config,
  onChanged,
  flash,
  onDismissFlash,
}: {
  account: Account;
  config: PublicConfig;
  onChanged: () => Promise<void>;
  /** Resultado de una operación hecha en otra pantalla (p. ej., dejar un club). */
  flash: string | null;
  onDismissFlash: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (id: string, a: 'accept' | 'decline') => {
    setBusy(id);
    setError(null);
    try {
      await answerInvitation(id, a);
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se ha podido responder a la invitación.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {flash && (
        <div className="notice club-outcome" role="status">
          <span>{flash}</span>
          <button type="button" className="btn btn-sm btn-ghost club-dismiss" onClick={onDismissFlash} aria-label="Cerrar aviso">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {account.transfers.length > 0 && (
        <section className="card club-transfer-offer">
          <h3>
            <Crown size={18} aria-hidden="true" />
            Te proponen la propiedad de un club
          </h3>
          <ul className="list">
            {account.transfers.map((t) => (
              <li key={t.id}>
                <a className="list-item club-link-row" href={clubHash(t.clubId, 'administradores')}>
                  <div className="list-main">
                    <strong>{t.clubName}</strong>
                    <span className="muted">Pendiente de tu respuesta · hasta el {formatDay(t.expiresAt)}</span>
                  </div>
                  <span className="club-link-label">Revisar</span>
                  <ChevronRight size={18} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {account.invitations.length > 0 && (
        <section className="card club-invitations">
          <h3>Invitaciones pendientes</h3>
          <ul className="list">
            {account.invitations.map((inv) => (
              <li key={inv.id} className="list-item">
                <div className="list-main">
                  <strong>{inv.clubName}</strong>
                  <span className="muted">Te invitan como administrador · hasta el {formatDay(inv.expiresAt)}</span>
                </div>
                <div className="list-side club-invitation-actions">
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => answer(inv.id, 'accept')}>
                    <Check size={16} aria-hidden="true" />
                    Aceptar
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => answer(inv.id, 'decline')}>
                    <X size={16} aria-hidden="true" />
                    Rechazar
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <ErrorBox message={error} />
        </section>
      )}

      <h2 className="section-title">Tus clubes</h2>
      {account.clubs.length === 0 ? (
        <section className="card empty-card">
          <p className="empty">Todavía no gestionas ningún club.</p>
        </section>
      ) : (
        <ul className="list card">
          {account.clubs.map((c) => (
            <li key={c.id}>
              <a className="list-item club-link-row" href={clubHash(c.id)}>
                <Building2 size={20} aria-hidden="true" />
                <div className="list-main">
                  <strong>{c.name}</strong>
                  {c.shortName && <span className="muted">{c.shortName}</span>}
                </div>
                <span className={`status club-role club-role-${c.role}`}>{ROLE_LABEL[c.role]}</span>
                <ChevronRight size={18} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}

      {config.publicSignup ? (
        <button type="button" className="btn btn-block" onClick={() => go('#/crear')}>
          <Plus size={18} aria-hidden="true" />
          Crear otro club
        </button>
      ) : (
        account.clubs.length === 0 && <p className="hint">El alta de clubes nuevos abrirá próximamente. Si te invitan a un club, la invitación aparecerá aquí.</p>
      )}
    </>
  );
}

// --- Panel de un club ----------------------------------------------------------------

type Loaded = { clubId: string; detail?: ClubDetail; teams?: TeamSummary[]; error?: string };

const loadClub = (clubId: string): Promise<Loaded> =>
  Promise.all([getClub(clubId), getTeams(clubId)]).then(
    ([detail, t]) => ({ clubId, detail, teams: t.teams }),
    (e: unknown) => ({ clubId, error: e instanceof ApiError ? e.message : 'No se ha podido cargar el club.' }),
  );

interface ClubPanelProps {
  account: Account;
  clubId: string;
  section: Section;
  /** Vuelve a pedir la cuenta (clubes, roles, invitaciones y transferencias). */
  onAccountChanged: () => Promise<void>;
  /** La cuenta ha dejado el club. */
  onLeft: (message: string) => void;
}

export function ClubPanel({ account, clubId, section, onAccountChanged, onLeft }: ClubPanelProps) {
  const [state, setState] = useState<Loaded>({ clubId });

  useEffect(() => {
    let cancelled = false;
    loadClub(clubId).then((s) => !cancelled && setState(s));
    return () => {
      cancelled = true;
    };
  }, [clubId]);

  // Tras cada operación se vuelven a pedir la ficha y la cuenta. Mientras llegan se
  // conservan los datos actuales; si se ha perdido el acceso, aparece el error.
  const reload = async () => {
    const [s] = await Promise.all([loadClub(clubId), onAccountChanged().catch(() => undefined)]);
    setState(s);
  };

  // Al cambiar de club nunca se muestran los datos del anterior.
  const current = state.clubId === clubId ? state : { clubId };
  if (current.error) {
    return (
      <section className="card">
        <ErrorBox message={current.error} />
        <button type="button" className="btn btn-block" onClick={() => go('#/')}>
          Volver a tus clubes
        </button>
      </section>
    );
  }
  if (!current.detail || !current.teams) return <Loading />;
  const { detail, teams } = current;

  return (
    <>
      <section className="club-title">
        <div>
          <h2>{detail.club.name}</h2>
          {detail.club.shortName && <span className="muted">{detail.club.shortName}</span>}
        </div>
        <span className={`status club-role club-role-${detail.role}`}>{ROLE_LABEL[detail.role]}</span>
      </section>

      {account.clubs.length > 1 && (
        <label className="club-switch">
          Club
          <select value={clubId} onChange={(e) => go(clubHash(e.target.value, section))}>
            {account.clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {ROLE_LABEL[c.role]}
              </option>
            ))}
          </select>
        </label>
      )}

      <nav className="segmented club-sections" aria-label="Secciones del club">
        {SECTIONS.map((s) => (
          <a key={s} href={clubHash(clubId, s)} aria-current={s === section ? 'page' : undefined} className={s === section ? 'active' : undefined}>
            {SECTION_LABEL[s]}
          </a>
        ))}
      </nav>

      {detail.club.status !== 'active' && <p className="notice">El club está suspendido: se puede consultar, pero no modificar.</p>}

      {section === 'resumen' && <Summary detail={detail} teams={teams} />}
      {section === 'equipos' && <Teams teams={teams} />}
      {section === 'temporadas' && <Seasons teams={teams} />}
      {section === 'codigos' && (
        <ComingSoon title="Códigos de entrenador y consulta">
          Aquí verás y renovarás los códigos con los que los entrenadores y las familias entran en la aplicación deportiva de
          cada equipo. Todavía no está disponible.
        </ComingSoon>
      )}
      {section === 'administradores' && <Admins account={account} detail={detail} onChanged={reload} onLeft={onLeft} />}
    </>
  );
}

function Summary({ detail, teams }: { detail: ClubDetail; teams: TeamSummary[] }) {
  const seasons = seasonsOf(teams);
  return (
    <>
      <section className="tiles">
        <div className="tile">
          <span className="tile-label">Equipos</span>
          <strong className="tile-value">{teams.length}</strong>
        </div>
        <div className="tile">
          <span className="tile-label">Temporadas</span>
          <strong className="tile-value">{seasons.length}</strong>
        </div>
        <div className="tile">
          <span className="tile-label">Administradores</span>
          <strong className="tile-value">{(detail.owner ? 1 : 0) + detail.admins.length}</strong>
        </div>
      </section>
      <section className="card kv">
        <div className="kv-row">
          <span>Tu rol</span>
          <strong>{ROLE_LABEL[detail.role]}</strong>
        </div>
        <div className="kv-row">
          <span>Estado</span>
          <strong>{detail.club.status === 'active' ? 'Activo' : 'Suspendido'}</strong>
        </div>
        {detail.owner && (
          <div className="kv-row">
            <span>Propiedad desde</span>
            <strong>{formatDay(detail.owner.since)}</strong>
          </div>
        )}
      </section>
      <p className="hint">Las herramientas de gestión llegarán por partes. Mientras tanto, lo que aún no está disponible aparece marcado como «Próximamente».</p>
    </>
  );
}

function Teams({ teams }: { teams: TeamSummary[] }) {
  return (
    <>
      {teams.length === 0 ? (
        <section className="card empty-card">
          <p className="empty">Este club todavía no tiene equipos.</p>
        </section>
      ) : (
        <ul className="list card">
          {teams.map((t) => (
            <li key={t.id} className="list-item">
              <div className="list-main">
                <strong>{t.name}</strong>
                <span className="muted">
                  {[t.code, t.season, t.category, t.gender ? GENDER_LABEL[t.gender] : null].filter(Boolean).join(' · ')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ComingSoon title="Crear y editar equipos">Dar de alta equipos y cambiar sus datos desde aquí todavía no está disponible.</ComingSoon>
    </>
  );
}

function Seasons({ teams }: { teams: TeamSummary[] }) {
  const seasons = seasonsOf(teams);
  return (
    <>
      {seasons.length === 0 ? (
        <section className="card empty-card">
          <p className="empty">Sin temporadas: aparecerán con los equipos.</p>
        </section>
      ) : (
        <ul className="list card">
          {seasons.map((s) => (
            <li key={s} className="list-item">
              <div className="list-main">
                <strong>{s}</strong>
                <span className="muted">{teams.filter((t) => t.season === s).length} equipos</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ComingSoon title="Gestión de temporadas">Abrir una temporada nueva y pasar equipos de una a otra todavía no está disponible.</ComingSoon>
    </>
  );
}
